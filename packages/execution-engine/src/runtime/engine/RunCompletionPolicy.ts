import type { CoreMessage } from "ai";
import { RUN_TERMINAL_STATES, RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import { RunTerminalStateSchema } from "@repo/shared-types";
import type { RunTerminalState } from "@repo/shared-types";
import type { MemoryCoordinator } from "../memory/index.js";
import type { Run, RunRepository } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import { buildPlanningRecoveryMessage } from "./RunPlanningRecoveryPolicy.js";
import {
  recordLifecycleStep,
  recordOrchestrationTerminal,
  recordPhaseSelectionSnapshot,
} from "./RunMetadataPolicy.js";
import { sanitizeUserFacingOutput } from "./RunOutputSanitizer.js";
import { transitionRunToCompleted } from "./RunStatusPolicy.js";

const PLANNER_DIAGNOSTIC_MAX_LENGTH = 160;

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
  runRepo: Pick<RunRepository, "update">;
  safeMemoryOperation: <T>(
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
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

export async function completeRunWithAssistantMessage(params: {
  run: Run;
  text: string;
  metadata?: Record<string, unknown>;
  deps: RunCompletionDependencies;
}): Promise<Response> {
  const { run, text, metadata, deps } = params;
  const sanitizedText = sanitizeUserFacingOutput(text);
  const terminalState =
    parseTerminalState(metadata) ?? RUN_TERMINAL_STATES.COMPLETED;
  recordLifecycleStep(run, "SYNTHESIS");
  await deps.runEventRecorder.recordRunStatusChanged(
    run.status,
    run.status,
    RUN_WORKFLOW_STEPS.SYNTHESIS,
  );

  await persistSynthesisArtifacts({ run, sanitizedText, deps });
  transitionRunToCompleted(run, run.id);
  recordLifecycleStep(run, "TERMINAL", "status=COMPLETED");
  recordOrchestrationTerminal(run);
  run.output = {
    content: sanitizedText,
    finalSummary: sanitizedText,
  };
  run.metadata.terminalState = terminalState;
  await deps.runRepo.update(run);
  await deps.runEventRecorder.recordMessageEmitted(
    "assistant",
    sanitizedText,
    metadata,
  );
  await deps.runEventRecorder.recordRunCompleted(
    getRunDurationMs(run),
    run.metadata.agenticLoop?.toolExecutionCount ?? 0,
  );
  console.log(`[run/engine] Completed assistant run ${run.id}`);

  return createStreamResponse(sanitizedText);
}

export async function completeRunWithRecoveredAssistantMessage(params: {
  run: Run;
  text: string;
  plannerError?: unknown;
  metadata?: Record<string, unknown>;
  errorMetadata?: string;
  deps: RunCompletionDependencies;
}): Promise<Response> {
  const { run, text, plannerError, metadata, errorMetadata, deps } = params;
  const sanitizedText = sanitizeUserFacingOutput(text);
  const terminalState =
    parseTerminalState(metadata) ?? RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS;
  recordLifecycleStep(run, "SYNTHESIS", "planning_recovery");
  await deps.runEventRecorder.recordRunStatusChanged(
    run.status,
    run.status,
    RUN_WORKFLOW_STEPS.SYNTHESIS,
  );

  await persistSynthesisArtifacts({ run, sanitizedText, deps });
  transitionRunToCompleted(run, run.id);
  if (plannerError !== undefined) {
    run.metadata.error = buildPlannerRecoveryMetadata(plannerError);
  } else if (errorMetadata) {
    run.metadata.error = errorMetadata;
  }
  recordLifecycleStep(run, "TERMINAL", "status=COMPLETED:recoverable");
  recordOrchestrationTerminal(run);
  run.output = {
    content: sanitizedText,
    finalSummary: sanitizedText,
  };
  run.metadata.terminalState = terminalState;
  await deps.runRepo.update(run);
  await deps.runEventRecorder.recordMessageEmitted(
    "assistant",
    sanitizedText,
    metadata,
  );
  await deps.runEventRecorder.recordRunCompleted(getRunDurationMs(run), 0);

  console.log(`[run/engine] Completed run ${run.id} with recoverable error`);
  return createStreamResponse(sanitizedText);
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
  deps: RunCompletionDependencies;
}): Promise<void> {
  const { run, sanitizedText, deps } = params;

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
      runStatus: "COMPLETED",
      taskStatuses: {},
    }),
  );

  recordPhaseSelectionSnapshot(run, "synthesis");
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
