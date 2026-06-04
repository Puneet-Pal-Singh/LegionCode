import { RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import {
  isGoldenFlowToolName,
  type GoldenFlowToolName,
} from "../contracts/CodingToolGateway.js";
import { executeAgenticLoopTool } from "./AgenticLoopToolExecutor.js";
import {
  AgenticLoopCancelledError,
  type AgenticLoopProviderRetryEvent,
} from "./AgenticLoop.js";
import { getToolPresentation } from "../lib/ToolPresentation.js";
import type { Run } from "../run/index.js";
import type { RunRepository } from "../run/index.js";
import type { RuntimeExecutionService, TaskResult } from "../types.js";
import type { RunEventRecorder } from "../events/index.js";
import type { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import { resolveRunPermissionContext } from "./RunPermissionContextPolicy.js";
import { evaluateToolPermission } from "./RunRiskyActionPolicy.js";
import { PermissionGateError } from "./PermissionGateError.js";
import {
  ensureApprovalResolvedEventRecorded,
  waitForApprovalDecision,
} from "./RunApprovalWaitPolicy.js";
import type { RunEngineEnv } from "./RunEngineTypes.js";
import { recordLifecycleStep } from "./RunMetadataPolicy.js";
import { sanitizeUserFacingOutput } from "./RunOutputSanitizer.js";
import {
  classifyCurrentTurnIntent,
  classifyLocalDiffRelevance,
  requiresMutationForIntent,
  type CurrentTurnIntent,
  type LocalDiffRelevance,
} from "./RunCurrentTurnIntent.js";

interface AgenticLoopToolCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface AgenticLoopCallbacks {
  executeTool?: (toolCall: AgenticLoopToolCall) => Promise<TaskResult>;
  onAssistantMessage: (content: string) => Promise<void>;
  onProgress: (progress: AgenticLoopProgress | null) => Promise<void>;
  onProviderRetry: (event: AgenticLoopProviderRetryEvent) => Promise<void>;
  onToolRequested: (toolCall: AgenticLoopToolCall) => Promise<void>;
  onToolStarted: (toolCall: AgenticLoopToolCall) => Promise<void>;
  onToolCompleted: (
    toolCall: AgenticLoopToolCall,
    result: unknown,
    executionTimeMs: number,
  ) => Promise<void>;
  onToolFailed: (
    toolCall: AgenticLoopToolCall,
    error: string,
    executionTimeMs: number,
  ) => Promise<void>;
}

interface AgenticLoopProgress {
  phase: "planning" | "execution" | "synthesis";
  label: string;
  summary: string;
  status: "active" | "completed";
}

export function buildAgenticLoopCallbacks(input: {
  run: Run;
  directExecutionService?: RuntimeExecutionService;
  runEventRecorder: RunEventRecorder;
  permissionApprovalStore: PermissionApprovalStore;
  runRepo: RunRepository;
  env: RunEngineEnv;
  runId: string;
}): AgenticLoopCallbacks {
  let hasMutationEvidence = false;
  let scopeDecisionRequested = false;
  const currentTurnIntent = classifyCurrentTurnIntent(input.run.input.prompt);
  const mutationScopedTurn = requiresMutationForIntent(currentTurnIntent);
  const allowResumeGitPush = canResumeGitPushFromContinuation(input.run);
  return {
    executeTool: input.directExecutionService
      ? async (toolCall) =>
          executeDirectToolCall({
            run: input.run,
            toolCall,
            directExecutionService: input.directExecutionService!,
            runEventRecorder: input.runEventRecorder,
            permissionApprovalStore: input.permissionApprovalStore,
            runRepo: input.runRepo,
            env: input.env,
            runId: input.runId,
            hasMutationEvidence,
            currentTurnIntent,
            mutationScopedTurn,
            scopeDecisionRequested,
            allowResumeGitPush,
            setHasMutationEvidence: (value) => {
              hasMutationEvidence = value;
            },
            setScopeDecisionRequested: (value) => {
              scopeDecisionRequested = value;
            },
          })
      : undefined,
    onToolRequested: async (toolCall) => {
      const toolPresentation = getToolPresentation(
        toolCall.toolName,
        toolCall.args,
      );
      await input.runEventRecorder.recordToolRequested({
        id: toolCall.id,
        type: toolCall.toolName,
        input: {
          ...toolCall.args,
          description: toolPresentation.description,
          displayText: toolPresentation.displayText,
        },
      });
    },
    onProgress: async (progress) => {
      if (!progress) {
        return;
      }
      await input.runEventRecorder.recordRunProgress(
        progress.phase,
        progress.label,
        progress.summary,
        progress.status,
      );
    },
    onProviderRetry: async (event) => {
      await input.runEventRecorder.recordRunProgress(
        RUN_WORKFLOW_STEPS.EXECUTION,
        "Retrying model request",
        "The provider returned an unusable response. Retrying once before pausing the run.",
        "completed",
        {
          displayMode: "debug",
          metadata: {
            code: "MODEL_UNUSABLE_RESPONSE",
            retryable: true,
            providerId: event.providerId,
            modelId: event.modelId,
            anomalyCode: event.anomalyCode,
            finishReason: event.finishReason,
            statusCode: event.statusCode,
            attempt: event.attempt,
            nextAttempt: event.nextAttempt,
            maxAttempts: event.maxAttempts,
            retryCount: event.retryCount,
          },
        },
      );
    },
    onAssistantMessage: async (content) => {
      const sanitizedContent = sanitizeUserFacingOutput(content).trim();
      if (!sanitizedContent) {
        return;
      }
      await input.runEventRecorder.recordMessageEmitted(
        "assistant",
        sanitizedContent,
        undefined,
        {
          phase: "commentary",
          status: "completed",
        },
      );
    },
    onToolStarted: async (toolCall) => {
      await input.runEventRecorder.recordToolStarted({
        id: toolCall.id,
        type: toolCall.toolName,
      });
    },
    onToolCompleted: async (toolCall, result, executionTimeMs) => {
      if (toolCall.toolName === "write_file") {
        hasMutationEvidence = true;
      }
      await input.runEventRecorder.recordToolCompleted(
        {
          id: toolCall.id,
          type: toolCall.toolName,
        },
        result,
        executionTimeMs,
      );
    },
    onToolFailed: async (toolCall, error, executionTimeMs) => {
      await input.runEventRecorder.recordToolFailed(
        {
          id: toolCall.id,
          type: toolCall.toolName,
        },
        error,
        executionTimeMs,
      );
    },
  };
}

async function executeDirectToolCall(input: {
  run: Run;
  toolCall: AgenticLoopToolCall;
  directExecutionService: RuntimeExecutionService;
  runEventRecorder: RunEventRecorder;
  permissionApprovalStore: PermissionApprovalStore;
  runRepo: RunRepository;
  env: RunEngineEnv;
  runId: string;
  hasMutationEvidence: boolean;
  currentTurnIntent: CurrentTurnIntent;
  mutationScopedTurn: boolean;
  scopeDecisionRequested: boolean;
  allowResumeGitPush: boolean;
  setHasMutationEvidence: (value: boolean) => void;
  setScopeDecisionRequested: (value: boolean) => void;
}): Promise<TaskResult> {
  const toolPresentation = getToolPresentation(
    input.toolCall.toolName,
    input.toolCall.args,
  );
  if (!isGoldenFlowToolName(input.toolCall.toolName)) {
    throw new Error(
      `Unsupported direct agentic tool: ${input.toolCall.toolName}`,
    );
  }

  const shouldProbeWorkspaceState = needsGitMutationEvidenceProbe(
    input.toolCall.toolName,
  );
  const workspaceMutationProbe = shouldProbeWorkspaceState
    ? await detectWorkspaceMutationEvidence(input.directExecutionService)
    : {
        hasMutationEvidence: false,
        changedFiles: [] as string[],
        probeFailed: false,
        probeError: undefined,
      };
  if (
    shouldProbeWorkspaceState &&
    workspaceMutationProbe.probeFailed &&
    !input.hasMutationEvidence
  ) {
    throw PermissionGateError.fromDeny(
      buildMutationProbeFailureMessage(workspaceMutationProbe.probeError),
    );
  }
  const hasWorkspaceMutationEvidence =
    !input.hasMutationEvidence && workspaceMutationProbe.hasMutationEvidence;
  const hasMutationEvidence =
    input.hasMutationEvidence || hasWorkspaceMutationEvidence;
  if (hasWorkspaceMutationEvidence) {
    input.setHasMutationEvidence(true);
  }

  const diffRelevanceDenial = resolveLocalDiffScopeDenial({
    toolName: input.toolCall.toolName,
    toolArgs: input.toolCall.args,
    prompt: input.run.input.prompt,
    mutationScopedTurn: input.mutationScopedTurn,
    scopeDecisionRequested: input.scopeDecisionRequested,
    changedFiles: workspaceMutationProbe.changedFiles,
  });
  if (diffRelevanceDenial) {
    input.setScopeDecisionRequested(true);
    throw PermissionGateError.fromDeny(diffRelevanceDenial);
  }

  const permissionState =
    input.run.metadata.permissionContext?.state ??
    resolveRunPermissionContext(input.run.input).state;
  const permissionResult = await evaluateToolPermission({
    runId: input.run.id,
    sessionId: input.run.sessionId,
    origin: "agent",
    productMode: permissionState.productMode,
    workflowIntent: permissionState.workflowIntent,
    toolName: input.toolCall.toolName,
    toolArgs: input.toolCall.args,
    currentTurnIntent: input.currentTurnIntent,
    hasMutationEvidence,
    allowResumeGitPush: input.allowResumeGitPush,
    ownerUserId: input.run.metadata.actorUserId,
    approvalStore: input.permissionApprovalStore,
  });
  if (permissionResult.kind === "ask") {
    recordLifecycleStep(
      input.run,
      "APPROVAL_WAIT",
      "structured approval request emitted",
    );
    await input.runEventRecorder.recordApprovalRequested(
      permissionResult.request,
    );
    const approvalOutcome = await waitForApprovalDecision({
      request: permissionResult.request,
      env: input.env,
      runId: input.runId,
      runRepo: input.runRepo,
      permissionApprovalStore: input.permissionApprovalStore,
    });
    if (
      approvalOutcome.outcome === "approved" ||
      approvalOutcome.outcome === "denied" ||
      approvalOutcome.outcome === "aborted"
    ) {
      await ensureApprovalResolvedEventRecorded({
        runEventRecorder: input.runEventRecorder,
        requestId: permissionResult.request.requestId,
        decision:
          approvalOutcome.decision ??
          (approvalOutcome.outcome === "approved"
            ? "allow_once"
            : approvalOutcome.outcome === "aborted"
              ? "abort"
              : "deny"),
        status:
          approvalOutcome.outcome === "approved"
            ? "approved"
            : approvalOutcome.outcome === "aborted"
              ? "aborted"
              : "denied",
      });
    }
    if (approvalOutcome.outcome === "approved") {
      // Continue with the original tool call after approval is granted.
    } else if (approvalOutcome.outcome === "timed_out") {
      throw PermissionGateError.fromAsk(permissionResult.request);
    } else if (approvalOutcome.outcome === "cancelled") {
      throw new AgenticLoopCancelledError(
        "Run was cancelled while waiting for approval.",
      );
    } else if (approvalOutcome.outcome === "aborted") {
      throw PermissionGateError.fromDeny("Approval request was aborted.");
    } else {
      throw PermissionGateError.fromDeny("Approval request was denied.");
    }
  }

  if (permissionResult.kind === "deny") {
    throw PermissionGateError.fromDeny(permissionResult.reason);
  }

  const result = await executeAgenticLoopTool(input.directExecutionService, {
    taskId: input.toolCall.id,
    toolName: input.toolCall.toolName,
    toolInput: {
      description: toolPresentation.description,
      displayText: toolPresentation.displayText,
      ...input.toolCall.args,
      __runtimeFeatureFlags: resolveRuntimeFeatureFlags(
        input.run.input.metadata,
      ),
    },
    onOutputAppended: async (chunk) => {
      await input.runEventRecorder.recordToolOutputAppended(
        {
          id: input.toolCall.id,
          type: input.toolCall.toolName,
        },
        chunk,
      );
    },
  });
  if (input.toolCall.toolName === "write_file") {
    input.setHasMutationEvidence(true);
  }
  return result;
}

function needsGitMutationEvidenceProbe(toolName: GoldenFlowToolName): boolean {
  return (
    toolName === "git_stage" ||
    toolName === "git_commit" ||
    toolName === "git_push"
  );
}

async function detectWorkspaceMutationEvidence(
  executionService: RuntimeExecutionService,
): Promise<{
  hasMutationEvidence: boolean;
  changedFiles: string[];
  probeFailed: boolean;
  probeError?: string;
}> {
  try {
    const result = await executionService.execute("git", "git_status", {});
    const payload = extractJsonOutputPayload(result);
    if (!payload) {
      return {
        hasMutationEvidence: false,
        changedFiles: [],
        probeFailed: false,
      };
    }

    const hasStaged = payload.hasStaged === true;
    const hasUnstaged = payload.hasUnstaged === true;
    const files = Array.isArray(payload.files) ? payload.files : [];
    const changedFiles = files
      .map((file) => {
        if (typeof file === "string") {
          return file.trim();
        }

        const record = toRecord(file);
        return record && typeof record.path === "string"
          ? record.path.trim()
          : "";
      })
      .filter((filePath): filePath is string => filePath.length > 0);

    return {
      hasMutationEvidence: hasStaged || hasUnstaged || files.length > 0,
      changedFiles,
      probeFailed: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(
      `[agentic-loop/callbacks] git_status mutation probe failed: ${errorMessage}`,
    );
    return {
      hasMutationEvidence: false,
      changedFiles: [],
      probeFailed: true,
      probeError: errorMessage,
    };
  }
}

function resolveLocalDiffScopeDenial(input: {
  toolName: GoldenFlowToolName;
  toolArgs: Record<string, unknown>;
  prompt: string;
  mutationScopedTurn: boolean;
  scopeDecisionRequested: boolean;
  changedFiles: string[];
}): string | null {
  if (!input.mutationScopedTurn || input.scopeDecisionRequested) {
    return null;
  }

  if (!needsGitMutationEvidenceProbe(input.toolName)) {
    return null;
  }

  if (input.changedFiles.length === 0) {
    return null;
  }

  const relevance = classifyLocalDiffRelevance({
    prompt: input.prompt,
    changedFiles: input.changedFiles,
    requestedFiles: extractRequestedFilesFromGitArgs(
      input.toolName,
      input.toolArgs,
    ),
  });
  if (relevance === "relevant") {
    return null;
  }

  return buildLocalDiffScopePrompt(relevance, input.changedFiles);
}

function extractRequestedFilesFromGitArgs(
  toolName: GoldenFlowToolName,
  toolArgs: Record<string, unknown>,
): string[] {
  if (toolName !== "git_stage") {
    return [];
  }

  const files = toolArgs.files;
  if (!Array.isArray(files)) {
    return [];
  }

  return files
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function buildLocalDiffScopePrompt(
  relevance: LocalDiffRelevance,
  changedFiles: string[],
): string {
  const changedPreview =
    changedFiles.length === 0
      ? "none detected"
      : changedFiles.slice(0, 6).join(", ");
  const reason =
    relevance === "unrelated"
      ? "the current local diff appears unrelated to this request"
      : "the current local diff scope is ambiguous for this request";

  return [
    `Before staging/committing/pushing, I need one scope decision because ${reason}.`,
    `Detected changed files: ${changedPreview}.`,
    "Tell me exactly which files or target scope to use, then I will continue.",
  ].join(" ");
}

function buildMutationProbeFailureMessage(
  probeError: string | undefined,
): string {
  const detail = probeError ? ` git_status failed with: ${probeError}.` : "";
  return [
    "I couldn't verify local workspace changes before staging/committing/pushing.",
    detail,
    "Retry the request so I can re-check git status, or provide explicit file scope.",
  ]
    .join(" ")
    .trim();
}

function extractJsonOutputPayload(
  value: unknown,
): Record<string, unknown> | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  if (record.success === false) {
    return null;
  }

  const output = record.output;
  if (typeof output !== "string" || output.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    return toRecord(parsed);
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function resolveRuntimeFeatureFlags(
  metadata: Record<string, unknown> | undefined,
): {
  ghCliLaneEnabled: boolean;
  ghCliCiEnabled: boolean;
  ghCliPrCommentEnabled: boolean;
} {
  const featureFlags =
    metadata?.featureFlags && typeof metadata.featureFlags === "object"
      ? (metadata.featureFlags as Record<string, unknown>)
      : undefined;

  const readBoolean = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : undefined;

  const ghCliLaneEnabled = readBoolean(featureFlags?.ghCliLaneEnabled) ?? false;
  const ghCliCiEnabled =
    readBoolean(featureFlags?.ghCliCiEnabled) ?? ghCliLaneEnabled;
  const ghCliPrCommentEnabled =
    readBoolean(featureFlags?.ghCliPrCommentEnabled) ?? false;
  return {
    ghCliLaneEnabled,
    ghCliCiEnabled,
    ghCliPrCommentEnabled,
  };
}

function canResumeGitPushFromContinuation(run: Run): boolean {
  const continuation = run.metadata.continuation;
  if (!continuation || continuation.failedToolName !== "git_push") {
    return false;
  }

  if (!continuation.hasTrustedGitCommitIdentity) {
    return false;
  }

  return continuation.completedGitSteps.some((step) =>
    /^Commit created:/i.test(step.trim()),
  );
}
