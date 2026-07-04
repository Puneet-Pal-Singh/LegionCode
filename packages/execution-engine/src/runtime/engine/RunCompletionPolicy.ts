import type { CoreMessage } from "ai";
import { RUN_TERMINAL_STATES, RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import { RunTerminalStateSchema } from "@repo/shared-types";
import type { RunTerminalState } from "@repo/shared-types";
import type { MemoryCoordinator } from "../memory/index.js";
import type { Run, RunRepository } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import type { AgenticLoopToolLifecycleEvent, RunStatus } from "../types.js";
import { buildPlanningRecoveryMessage } from "./RunPlanningRecoveryPolicy.js";
import {
  recordLifecycleStep,
  recordOrchestrationTerminal,
  recordPhaseSelectionSnapshot,
} from "./RunMetadataPolicy.js";
import { sanitizeUserFacingOutput } from "./RunOutputSanitizer.js";
import {
  transitionRunToCompleted,
  transitionRunToFailed,
  transitionRunToPaused,
} from "./RunStatusPolicy.js";
import { FinalAssistantMessageService } from "./FinalAssistantMessageService.js";
import {
  buildEvidenceLedger,
  evaluateFinalizationContract,
  readFinalizationEvidenceRequirements,
  type FinalizationContract,
} from "./EvidenceLedger.js";

const PLANNER_DIAGNOSTIC_MAX_LENGTH = 160;
type RecoveredRunTerminalStatus = Extract<RunStatus, "COMPLETED" | "PAUSED">;
type FinalizedRunTerminalStatus = Extract<
  RunStatus,
  "COMPLETED" | "PAUSED" | "FAILED"
>;

type PlannerRecoveryErrorCode =
  | "PLANNER_TIMEOUT"
  | "PLANNER_INVALID_RESPONSE"
  | "UNKNOWN_PLANNER_ERROR";

export interface RunCompletionDependencies {
  memoryCoordinator: MemoryCoordinator;
  persistConversationMessages: (
    runId: string,
    sessionId: string,
    messages: CoreMessage[],
    role: "user" | "assistant",
  ) => Promise<void>;
  runEventRecorder: RunEventRecorder;
  runRepo: Pick<RunRepository, "getById" | "updateUnlessStatus">;
  safeMemoryOperation: <T>(
    operation: () => Promise<T>,
  ) => Promise<T>;
}

interface RunAssistantFinalizationParams {
  run: Run;
  text: string;
  metadata?: Record<string, unknown>;
  deps: RunCompletionDependencies;
}

interface PersistFinalAssistantRunParams extends RunAssistantFinalizationParams {
  terminalState: RunTerminalState;
  terminalStatus: FinalizedRunTerminalStatus;
}

export function createStreamResponse(content: string): Response {
  const safeContent = sanitizeUserFacingOutput(content);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(safeContent));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}

export async function finalizeRunWithAssistantMessage(
  params: RunAssistantFinalizationParams,
): Promise<Response> {
  const terminalState =
    parseTerminalState(params.metadata) ?? RUN_TERMINAL_STATES.COMPLETED;
  if (terminalState === RUN_TERMINAL_STATES.APPROVAL_REQUIRED) {
    return pauseRunForApprovalWithAssistantMessage(params);
  }

  return completeRunWithAssistantMessage(params);
}

export async function completeRunWithAssistantMessage(
  params: RunAssistantFinalizationParams,
): Promise<Response> {
  const terminalState =
    parseTerminalState(params.metadata) ?? RUN_TERMINAL_STATES.COMPLETED;
  assertCompletionTerminalState(terminalState);
  return persistFinalAssistantRun({
    ...params,
    terminalState,
    terminalStatus: resolveFinalizedRunStatus(terminalState),
  });
}

export async function pauseRunForApprovalWithAssistantMessage(
  params: RunAssistantFinalizationParams,
): Promise<Response> {
  const terminalState =
    parseTerminalState(params.metadata) ?? RUN_TERMINAL_STATES.APPROVAL_REQUIRED;
  assertApprovalTerminalState(terminalState);
  return persistFinalAssistantRun({
    ...params,
    terminalState,
    terminalStatus: "PAUSED",
  });
}

async function persistFinalAssistantRun(
  params: PersistFinalAssistantRunParams,
): Promise<Response> {
  const { run, text, metadata, deps } = params;
  const previousStatus = run.status;
  if (await isRunCancelledInStore(run, deps)) {
    console.log(
      `[run/engine] Skipping assistant completion for cancelled run ${run.id}`,
    );
    return createStreamResponse("");
  }
  const finalization = settleFinalizationContract({ run, metadata });
  const terminalState = finalization.contract.settled
    ? params.terminalState
    : RUN_TERMINAL_STATES.FAILED_VALIDATION;
  const terminalStatus = finalization.contract.settled
    ? params.terminalStatus
    : "FAILED";
  const finalText = finalization.contract.settled
    ? text
    : buildMissingEvidenceFinalText(finalization.contract);
  const finalMetadata = buildTerminalFinalMetadata({
    run,
    metadata: finalization.metadata,
    terminalState,
  });
  const finalMessage = buildFinalAssistantMessage({
    run,
    text: finalText,
    metadata: finalMetadata,
    terminalState,
  });
  const sanitizedText = sanitizeUserFacingOutput(finalMessage.content);
  console.log(
    `[run/completion/finalization-started] runId=${run.id} previousStatus=${previousStatus} terminalStatus=${terminalStatus} terminalState=${terminalState} textLength=${sanitizedText.length}`,
  );
  recordLifecycleStep(run, "SYNTHESIS");
  transitionFinalAssistantRun(run, terminalStatus);
  recordLifecycleStep(run, "TERMINAL", `status=${terminalStatus}`);
  recordOrchestrationTerminal(run);
  run.output = {
    content: sanitizedText,
    finalSummary: sanitizedText,
  };
  run.metadata.terminalState = terminalState;
  run.metadata.terminalMessage = finalMessage.metadata;
  run.metadata.evidenceLedger = finalization.ledger;
  run.metadata.finalizationContract = finalization.contract;
  if (!(await updateFinalizedRunIfActive(run, deps, terminalStatus))) {
    console.log(
      `[run/completion/finalization-skipped] runId=${run.id} reason=terminal-or-blocked terminalStatus=${terminalStatus}`,
    );
    return createStreamResponse("");
  }
  console.log(
    `[run/completion/run-persisted] runId=${run.id} status=${run.status} terminalState=${terminalState}`,
  );
  recordPhaseSelectionSnapshot(run, "synthesis");
  await deps.runEventRecorder.recordRunStatusChanged(
    previousStatus,
    run.status,
    RUN_WORKFLOW_STEPS.SYNTHESIS,
  );
  await persistSynthesisArtifacts({
    run,
    sanitizedText,
    checkpointStatus: terminalStatus,
    deps,
  });
  await deps.runEventRecorder.recordMessageEmitted(
    "assistant",
    sanitizedText,
    finalMessage.metadata,
  );
  if (terminalStatus === "COMPLETED") {
    await deps.runEventRecorder.recordRunCompleted(
      getRunDurationMs(run),
      run.metadata.agenticLoop?.toolExecutionCount ?? 0,
    );
  }
  if (terminalStatus === "FAILED") {
    await deps.runEventRecorder.recordRunFailed(
      sanitizedText,
      getRunDurationMs(run),
    );
  }
  console.log(
    `[run/completion/finalization-finished] runId=${run.id} status=${run.status} terminalStatus=${terminalStatus} terminalState=${terminalState}`,
  );

  return createStreamResponse(sanitizedText);
}

export async function completeRunWithRecoveredAssistantMessage(params: {
  run: Run;
  text: string;
  plannerError?: unknown;
  metadata?: Record<string, unknown>;
  errorMetadata?: string;
  terminalStatus?: RecoveredRunTerminalStatus;
  deps: RunCompletionDependencies;
}): Promise<Response> {
  const {
    run,
    text,
    plannerError,
    metadata,
    errorMetadata,
    terminalStatus = "COMPLETED",
    deps,
  } = params;
  const previousStatus = run.status;
  if (await isRunCancelledInStore(run, deps)) {
    console.log(
      `[run/engine] Skipping recovered completion for cancelled run ${run.id}`,
    );
    return createStreamResponse("");
  }
  const terminalState =
    parseTerminalState(metadata) ?? RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS;
  const finalMetadata = buildTerminalFinalMetadata({
    run,
    metadata,
    terminalState,
  });
  const finalMessage = buildFinalAssistantMessage({
    run,
    text,
    metadata: finalMetadata,
    terminalState,
  });
  const sanitizedText = sanitizeUserFacingOutput(finalMessage.content);
  recordLifecycleStep(run, "SYNTHESIS", "planning_recovery");
  transitionRecoveredRun(run, terminalStatus);
  if (plannerError !== undefined) {
    run.metadata.error = buildPlannerRecoveryMetadata(plannerError);
  } else if (errorMetadata) {
    run.metadata.error = errorMetadata;
  }
  recordLifecycleStep(
    run,
    "TERMINAL",
    buildRecoveredLifecycleDetail(terminalStatus),
  );
  recordOrchestrationTerminal(run);
  run.output = {
    content: sanitizedText,
    finalSummary: sanitizedText,
  };
  run.metadata.terminalState = terminalState;
  run.metadata.terminalMessage = finalMessage.metadata;
  if (!(await updateRecoveredRunIfActive(run, deps))) {
    console.log(
      `[run/engine] Skipping recovered completion for terminal run ${run.id}`,
    );
    return createStreamResponse("");
  }
  recordPhaseSelectionSnapshot(run, "synthesis");
  await deps.runEventRecorder.recordRunStatusChanged(
    previousStatus,
    run.status,
    RUN_WORKFLOW_STEPS.SYNTHESIS,
  );
  await persistSynthesisArtifacts({
    run,
    sanitizedText,
    checkpointStatus: terminalStatus,
    deps,
  });
  await deps.runEventRecorder.recordMessageEmitted(
    "assistant",
    sanitizedText,
    finalMessage.metadata,
  );
  if (terminalStatus === "COMPLETED") {
    await deps.runEventRecorder.recordRunCompleted(getRunDurationMs(run), 0);
  }

  console.log(`[run/engine] Completed run ${run.id} with recoverable error`);
  return createStreamResponse(sanitizedText);
}

function buildFinalAssistantMessage(input: {
  run: Run;
  text: string;
  metadata?: Record<string, unknown>;
  terminalState: RunTerminalState;
}) {
  return new FinalAssistantMessageService().build({
    runId: input.run.id,
    sessionId: input.run.sessionId,
    terminalState: input.terminalState,
    modelText: input.text,
    metadata: input.metadata,
  });
}

function buildTerminalFinalMetadata(input: {
  run: Run;
  metadata?: Record<string, unknown>;
  terminalState: RunTerminalState;
}): Record<string, unknown> {
  const lifecycle = input.run.metadata.agenticLoop?.toolLifecycle ?? [];
  const changedFileCount =
    readNonNegativeInteger(input.metadata?.changedFileCount) ??
    countChangedFiles(lifecycle);
  const lastSuccessfulStep =
    readNonEmptyString(input.metadata?.lastSuccessfulStep) ??
    getLatestToolName(lifecycle, "completed");
  const failedStep =
    readNonEmptyString(input.metadata?.failedStep) ??
    getLatestToolName(lifecycle, "failed");
  const nextAction =
    readNonEmptyString(input.metadata?.nextAction) ??
    readNonEmptyString(input.metadata?.resumeHint) ??
    resolveDefaultTerminalNextAction(input.terminalState);

  return {
    ...(input.metadata ?? {}),
    terminalState: input.terminalState,
    changedFileCount,
    artifactId: input.metadata?.artifactId ?? null,
    lastSuccessfulStep,
    failedStep,
    nextAction,
  };
}

function settleFinalizationContract(input: {
  run: Run;
  metadata?: Record<string, unknown>;
}): {
  ledger: ReturnType<typeof buildEvidenceLedger>;
  contract: FinalizationContract;
  metadata: Record<string, unknown>;
} {
  const ledger = buildEvidenceLedger(
    input.run.metadata.agenticLoop?.toolLifecycle ?? [],
  );
  const requiredEvidence = readFinalizationEvidenceRequirements(
    input.metadata?.requiredEvidence,
  );
  const contract = evaluateFinalizationContract({
    ledger,
    requiredEvidence,
  });
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };

  if (ledger.length > 0 || requiredEvidence.length > 0) {
    metadata.evidenceLedger = ledger;
    metadata.finalizationContract = contract;
  }

  if (!contract.settled) {
    metadata.code = "FINALIZATION_MISSING_EVIDENCE";
  }

  return { ledger, contract, metadata };
}

function buildMissingEvidenceFinalText(
  contract: FinalizationContract,
): string {
  return [
    "I cannot finalize that answer yet because this run did not record the required evidence.",
    `Missing evidence: ${contract.missingEvidence.join(", ")}`,
  ].join("\n");
}

function countChangedFiles(
  lifecycle: AgenticLoopToolLifecycleEvent[],
): number {
  const filePaths = new Set<string>();
  for (const event of lifecycle) {
    if (
      event.status === "completed" &&
      event.metadata?.family === "edit" &&
      event.metadata.filePath
    ) {
      filePaths.add(event.metadata.filePath);
    }
  }
  return filePaths.size;
}

function getLatestToolName(
  lifecycle: AgenticLoopToolLifecycleEvent[],
  status: AgenticLoopToolLifecycleEvent["status"],
): string | null {
  for (let index = lifecycle.length - 1; index >= 0; index -= 1) {
    const event = lifecycle[index];
    if (event?.status === status) {
      return event.toolName;
    }
  }
  return null;
}

function resolveDefaultTerminalNextAction(
  terminalState: RunTerminalState,
): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.COMPLETED:
      return "Send the next task when you want me to continue.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "Choose an approval action to continue, or deny to stop this path.";
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "Send a revised instruction or approve a safer action to continue.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "Resubmit the request when you want me to continue.";
    default:
      return "Review the completed work and retry the failed step.";
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function isRunCancelledInStore(
  run: Run,
  deps: RunCompletionDependencies,
): Promise<boolean> {
  const currentRun = await deps.runRepo.getById(run.id);
  return currentRun?.status === "CANCELLED";
}

async function updateFinalizedRunIfActive(
  run: Run,
  deps: RunCompletionDependencies,
  terminalStatus: FinalizedRunTerminalStatus,
): Promise<boolean> {
  const blockedStatuses: RunStatus[] =
    terminalStatus === "PAUSED"
      ? ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"]
      : ["COMPLETED", "FAILED", "CANCELLED"];

  return await deps.runRepo.updateUnlessStatus(run, blockedStatuses);
}

async function updateRecoveredRunIfActive(
  run: Run,
  deps: RunCompletionDependencies,
): Promise<boolean> {
  return await deps.runRepo.updateUnlessStatus(run, [
    "PAUSED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ]);
}

function transitionRecoveredRun(
  run: Run,
  terminalStatus: RecoveredRunTerminalStatus,
): void {
  if (terminalStatus === "PAUSED") {
    transitionRunToPaused(run, run.id);
    return;
  }

  transitionRunToCompleted(run, run.id);
}

function transitionFinalAssistantRun(
  run: Run,
  terminalStatus: FinalizedRunTerminalStatus,
): void {
  if (terminalStatus === "PAUSED") {
    transitionRunToPaused(run, run.id);
    return;
  }

  if (terminalStatus === "FAILED") {
    transitionRunToFailed(run, run.id);
    return;
  }

  transitionRunToCompleted(run, run.id);
}

function assertCompletionTerminalState(terminalState: RunTerminalState): void {
  if (terminalState === RUN_TERMINAL_STATES.APPROVAL_REQUIRED) {
    throw new Error(
      "completeRunWithAssistantMessage cannot finalize approval-required runs",
    );
  }
}

function assertApprovalTerminalState(terminalState: RunTerminalState): void {
  if (terminalState !== RUN_TERMINAL_STATES.APPROVAL_REQUIRED) {
    throw new Error(
      "pauseRunForApprovalWithAssistantMessage requires approval terminal state",
    );
  }
}

function resolveFinalizedRunStatus(
  terminalState: RunTerminalState,
): FinalizedRunTerminalStatus {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.FAILED_TOOL:
    case RUN_TERMINAL_STATES.FAILED_RUNTIME:
    case RUN_TERMINAL_STATES.FAILED_VALIDATION:
    case RUN_TERMINAL_STATES.FAILED_POLICY:
      return "FAILED";
    default:
      return "COMPLETED";
  }
}

function buildRecoveredLifecycleDetail(
  terminalStatus: RecoveredRunTerminalStatus,
): string {
  return terminalStatus === "PAUSED"
    ? "status=PAUSED:recoverable"
    : "status=COMPLETED:recoverable";
}

export async function tryHandlePlanningError(params: {
  run: Run;
  runId: string;
  error: unknown;
  deps: RunCompletionDependencies;
}): Promise<Response | null> {
  const { run, runId, error, deps } = params;
  const userMessage = buildPlanningRecoveryMessage(error);
  if (!userMessage) {
    return null;
  }
  const classification = classifyPlannerRecoveryError(error);

  console.warn(
    `[run/engine] Recoverable planning error for run ${runId}: code=${classification.code} detail=${classification.diagnosticDetail}`,
  );

  return completeRunWithRecoveredAssistantMessage({
    run,
    text: userMessage,
    plannerError: error,
    deps,
  });
}

export function getRunDurationMs(run: Run): number {
  const startedAt = run.metadata.startedAt ?? run.createdAt.toISOString();
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return 0;
  }
  return Math.max(0, Date.now() - startedAtMs);
}

async function persistSynthesisArtifacts(params: {
  run: Run;
  sanitizedText: string;
  checkpointStatus?: FinalizedRunTerminalStatus;
  deps: RunCompletionDependencies;
}): Promise<void> {
  const { run, sanitizedText, checkpointStatus = "COMPLETED", deps } = params;

  await deps.safeMemoryOperation(() =>
    deps.memoryCoordinator.extractAndPersist({
      runId: run.id,
      sessionId: run.sessionId,
      source: "synthesis",
      content: sanitizedText,
      phase: "synthesis",
    }),
  );

  await deps.safeMemoryOperation(() =>
    deps.persistConversationMessages(
      run.id,
      run.sessionId,
      [{ role: "assistant", content: sanitizedText }],
      "assistant",
    ),
  );

  await deps.safeMemoryOperation(() =>
    deps.memoryCoordinator.createCheckpoint({
      runId: run.id,
      sequence: 1,
      phase: "synthesis",
      runStatus: checkpointStatus,
      taskStatuses: {},
    }),
  );
}

function buildPlannerRecoveryMetadata(error: unknown): string {
  const classification = classifyPlannerRecoveryError(error);
  return `${classification.code}: ${classification.description}`;
}

function classifyPlannerRecoveryError(error: unknown): {
  code: PlannerRecoveryErrorCode;
  description: string;
  diagnosticDetail: string;
} {
  const detail = getBoundedDiagnosticDetail(error);
  const normalizedDetail = detail.toLowerCase();

  if (
    normalizedDetail.includes("did not match schema") ||
    normalizedDetail.includes("did not match required schema") ||
    normalizedDetail.includes("invalid structured")
  ) {
    return {
      code: "PLANNER_INVALID_RESPONSE",
      description: "Planner returned invalid structured output.",
      diagnosticDetail: detail,
    };
  }

  if (
    normalizedDetail.includes("timeout") ||
    normalizedDetail.includes("timed out") ||
    normalizedDetail.includes("abort")
  ) {
    return {
      code: "PLANNER_TIMEOUT",
      description: "Planner timed out before producing a valid plan.",
      diagnosticDetail: detail,
    };
  }

  return {
    code: "UNKNOWN_PLANNER_ERROR",
    description: "Planner failed before execution could continue.",
    diagnosticDetail: detail,
  };
}

function getBoundedDiagnosticDetail(error: unknown): string {
  const rawDetail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Unknown planner error";
  const normalized = rawDetail.replace(/\s+/g, " ").trim();

  if (normalized.length <= PLANNER_DIAGNOSTIC_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, PLANNER_DIAGNOSTIC_MAX_LENGTH)}...`;
}

function parseTerminalState(
  metadata: Record<string, unknown> | undefined,
): RunTerminalState | undefined {
  const state = metadata?.terminalState;
  if (typeof state !== "string") {
    return undefined;
  }
  const parsed = RunTerminalStateSchema.safeParse(state);
  return parsed.success ? parsed.data : undefined;
}
