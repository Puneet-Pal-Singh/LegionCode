import { RUN_TERMINAL_STATES, RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import {
  LLMTimeoutError,
  LLMUnusableResponseError,
} from "../llm/LLMGateway.js";
import type { AgenticLoop } from "./AgenticLoop.js";
import {
  buildTaskModelNoActionMetadata,
  buildTaskModelNoActionSummary,
  recordRecoveredAgenticLoopMetadata,
} from "./RunAgenticLoopPolicy.js";
import {
  classifyCurrentTurnIntent,
  requiresMutationForIntent,
  type CurrentTurnIntent,
} from "./RunCurrentTurnIntent.js";

const PROVIDER_UNAVAILABLE_SIGNAL_PATTERNS = [
  /failed after \d+ attempts?/i,
  /provider request failed/i,
  /provider returned error/i,
  /network connection lost/i,
  /connection lost/i,
  /service unavailable/i,
  /internal error encountered/i,
  /econnreset/i,
  /etimedout/i,
  /upstream (?:connect|request|transport|service|network|timed? out|error|failure)/i,
  /status code (?:500|502|503|504)/i,
];
const MAX_ERROR_SIGNAL_LENGTH = 240;

interface TaskExecutionRecoveryDependencies {
  completeRunWithRecoveredAssistantMessage: (
    run: Run,
    text: string,
    metadata?: Record<string, unknown>,
    errorMetadata?: string,
    terminalStatus?: "COMPLETED" | "PAUSED",
  ) => Promise<Response>;
  runEventRecorder: Pick<RunEventRecorder, "recordRunProgress">;
}

interface TaskExecutionRecoveryInput {
  run: Run;
  prompt: string;
  loop: AgenticLoop;
  error: unknown;
  deps: TaskExecutionRecoveryDependencies;
}

interface TaskExecutionRecoveryContext {
  stats: ReturnType<AgenticLoop["getStats"]>;
  requiresMutation: boolean;
  currentTurnIntent: CurrentTurnIntent;
}

export async function tryHandleTaskExecutionErrorPolicy(
  input: TaskExecutionRecoveryInput,
): Promise<Response | null> {
  const { error } = input;

  if (isTaskExecutionTimeout(error)) {
    return handleTaskTimeoutRecovery(input);
  }

  if (isTaskExecutionUnusableResponse(error)) {
    return handleUnusableResponseRecovery(input, error);
  }

  if (isRecoverableProviderUnavailable(error)) {
    return handleProviderUnavailableRecovery(input);
  }

  return null;
}

async function handleTaskTimeoutRecovery(
  input: Pick<
    TaskExecutionRecoveryInput,
    "run" | "prompt" | "loop" | "deps" | "error"
  >,
): Promise<Response> {
  const { run, deps } = input;
  const context = buildTaskExecutionRecoveryContext(input);
  const timeoutDetails = buildTaskTimeoutDetails(
    input.run,
    input.error,
    context,
  );
  const text = buildTaskExecutionTimeoutMessage({
    noFileChanged: context.stats.completedMutatingToolCount === 0,
    toolExecutionCount: context.stats.toolExecutionCount,
    stepsExecuted: context.stats.stepsExecuted,
    timeoutMs: timeoutDetails.timeoutMs,
    providerId: timeoutDetails.providerId,
    modelId: timeoutDetails.modelId,
    lastCompletedAction: timeoutDetails.lastCompletedAction,
  });
  const timeoutMetadata = buildTaskExecutionTimeoutMetadata({
    ...timeoutDetails,
    stepsExecuted: context.stats.stepsExecuted,
    toolExecutionCount: context.stats.toolExecutionCount,
    failedToolCount: context.stats.failedToolCount,
    completedMutatingToolCount: context.stats.completedMutatingToolCount,
    completedReadOnlyToolCount: context.stats.completedReadOnlyToolCount,
  });
  console.log(
    `[run/recovery] ${JSON.stringify({
      runId: run.id,
      sessionId: run.sessionId,
      reason: "task-execution-timeout",
      timeoutMs: timeoutDetails.timeoutMs,
      providerId: timeoutDetails.providerId,
      modelId: timeoutDetails.modelId,
      lastCompletedAction: timeoutDetails.lastCompletedAction,
      stepsExecuted: context.stats.stepsExecuted,
      toolExecutionCount: context.stats.toolExecutionCount,
      failedToolCount: context.stats.failedToolCount,
      completedMutatingToolCount: context.stats.completedMutatingToolCount,
      completedReadOnlyToolCount: context.stats.completedReadOnlyToolCount,
      llmRetryCount: context.stats.llmRetryCount,
      toolLifecycleCount: context.stats.toolLifecycle.length,
    })}`,
  );

  await deps.runEventRecorder.recordRunProgress(
    RUN_WORKFLOW_STEPS.EXECUTION,
    "Recoverable timeout",
    "The model timed out before choosing the next action.",
    "completed",
    { metadata: timeoutMetadata },
  );

  return deps.completeRunWithRecoveredAssistantMessage(
    run,
    text,
    timeoutMetadata,
    "TASK_EXECUTION_TIMEOUT: Model timed out before choosing the next action.",
  );
}

async function handleUnusableResponseRecovery(
  input: Pick<TaskExecutionRecoveryInput, "run" | "prompt" | "loop" | "deps">,
  error: LLMUnusableResponseError,
): Promise<Response> {
  const { run, deps } = input;
  const context = buildTaskExecutionRecoveryContext(input);
  const terminalLlmIssue =
    context.stats.terminalLlmIssue ??
    buildTerminalLlmIssueFromError(error, context.stats.llmRetryCount);
  recordRecoveredAgenticLoopMetadata(run, {
    stopReason: "llm_stop",
    stepsExecuted: context.stats.stepsExecuted,
    toolExecutionCount: context.stats.toolExecutionCount,
    failedToolCount: context.stats.failedToolCount,
    requiresMutation: context.requiresMutation,
    currentTurnIntent: context.currentTurnIntent,
    completedMutatingToolCount: context.stats.completedMutatingToolCount,
    completedReadOnlyToolCount: context.stats.completedReadOnlyToolCount,
    llmRetryCount: context.stats.llmRetryCount,
    terminalLlmIssue,
    recoveryCode: "TASK_MODEL_NO_ACTION",
    toolLifecycle: context.stats.toolLifecycle,
  });

  await deps.runEventRecorder.recordRunProgress(
    RUN_WORKFLOW_STEPS.EXECUTION,
    "Recoverable model issue",
    "The model returned an unusable response before the run could continue.",
    "completed",
  );

  return deps.completeRunWithRecoveredAssistantMessage(
    run,
    buildTaskModelNoActionSummary({
      requiresMutation: context.requiresMutation,
      toolLifecycle: context.stats.toolLifecycle,
    }),
    buildTaskModelNoActionMetadata(),
    buildUnusableResponseErrorMetadata(error, terminalLlmIssue),
  );
}

async function handleProviderUnavailableRecovery(
  input: Pick<
    TaskExecutionRecoveryInput,
    "run" | "prompt" | "loop" | "deps" | "error"
  >,
): Promise<Response> {
  const { run, deps } = input;
  const context = buildTaskExecutionRecoveryContext(input);
  const details = buildProviderUnavailableDetails(
    input.run,
    input.error,
    context,
  );
  const text = buildProviderUnavailableMessage({
    noFileChanged: context.stats.completedMutatingToolCount === 0,
  });

  await deps.runEventRecorder.recordRunProgress(
    RUN_WORKFLOW_STEPS.EXECUTION,
    "Provider interruption",
    "The selected model stopped responding after retrying.",
    "completed",
  );

  return deps.completeRunWithRecoveredAssistantMessage(
    run,
    text,
    buildProviderUnavailableMetadata(details),
    buildProviderUnavailableErrorMetadata(details),
    "PAUSED",
  );
}

function buildTaskExecutionRecoveryContext(
  input: Pick<TaskExecutionRecoveryInput, "prompt" | "loop">,
): TaskExecutionRecoveryContext {
  const currentTurnIntent = classifyCurrentTurnIntent(input.prompt);
  return {
    stats: input.loop.getStats(),
    requiresMutation: requiresMutationForIntent(currentTurnIntent),
    currentTurnIntent,
  };
}

function isTaskExecutionTimeout(error: unknown): boolean {
  if (error instanceof LLMTimeoutError) {
    return error.phase === "task";
  }

  return (
    error instanceof Error &&
    error.name === "LLMTimeoutError" &&
    error.message.includes("(phase=task)")
  );
}

function isTaskExecutionUnusableResponse(
  error: unknown,
): error is LLMUnusableResponseError {
  return error instanceof LLMUnusableResponseError;
}

function isRecoverableProviderUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const statusCodes = collectErrorStatusCodes(error);
  if (statusCodes.some((statusCode) => statusCode >= 500 && statusCode < 600)) {
    return true;
  }

  const signalText = getErrorSignalText(error);
  return PROVIDER_UNAVAILABLE_SIGNAL_PATTERNS.some((pattern) =>
    pattern.test(signalText),
  );
}

function buildTaskExecutionTimeoutMessage(input: {
  noFileChanged: boolean;
  toolExecutionCount: number;
  stepsExecuted: number;
  timeoutMs: number | null;
  providerId: string | null;
  modelId: string | null;
  lastCompletedAction: string | null;
}): string {
  const lines = ["The model timed out before choosing the next action."];

  if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) {
    lines.push(
      `Model response timeout: ${Math.round(input.timeoutMs / 1000)}s.`,
    );
  }

  const modelLabel = formatModelLabel(input.providerId, input.modelId);
  if (modelLabel) {
    lines.push(`Active model: ${modelLabel}.`);
  }
  if (input.lastCompletedAction) {
    lines.push(`Last completed action: ${input.lastCompletedAction}.`);
  }

  lines.push(
    input.noFileChanged
      ? "No file was changed before the timeout."
      : "The run timed out after some progress, but before it could finish the next step.",
    `Execution stats so far: ${input.stepsExecuted} step(s), ${input.toolExecutionCount} tool call(s).`,
  );

  lines.push("Retry the task or switch to a faster or more reliable model.");

  return lines.join("\n");
}

function buildProviderUnavailableMessage(input: {
  noFileChanged: boolean;
}): string {
  const lines = [
    "The selected model stopped responding, so I paused this run.",
    input.noFileChanged
      ? "No files were changed. The provider became unavailable after retrying."
      : "Some workspace changes may already exist. Review the changed files before retrying.",
  ];

  return lines.join("\n");
}

function buildTaskExecutionTimeoutMetadata(input: {
  timeoutMs: number | null;
  providerId: string | null;
  modelId: string | null;
  lastCompletedAction: string | null;
  stepsExecuted: number;
  toolExecutionCount: number;
  failedToolCount: number;
  completedMutatingToolCount: number;
  completedReadOnlyToolCount: number;
}): Record<string, unknown> {
  return {
    code: "TASK_EXECUTION_TIMEOUT",
    retryable: true,
    ...(typeof input.timeoutMs === "number"
      ? { timeoutMs: input.timeoutMs }
      : undefined),
    ...(input.providerId ? { providerId: input.providerId } : undefined),
    ...(input.modelId ? { modelId: input.modelId } : undefined),
    ...(input.lastCompletedAction
      ? { lastCompletedAction: input.lastCompletedAction }
      : undefined),
    stepsExecuted: input.stepsExecuted,
    toolExecutionCount: input.toolExecutionCount,
    failedToolCount: input.failedToolCount,
    completedMutatingToolCount: input.completedMutatingToolCount,
    completedReadOnlyToolCount: input.completedReadOnlyToolCount,
    noFilesChanged: input.completedMutatingToolCount === 0,
    resumeHint: "Retry the task or switch to a faster or more reliable model.",
    resumeActions: ["retry", "switch_model"],
  };
}

function buildProviderUnavailableMetadata(input: {
  providerId: string | null;
  modelId: string | null;
  statusCode: number | null;
  lastCompletedAction: string | null;
  retryCount: number;
  stepsExecuted: number;
  toolExecutionCount: number;
  completedMutatingToolCount: number;
  completedReadOnlyToolCount: number;
  noFilesChanged: boolean;
}): Record<string, unknown> {
  return {
    code: "PROVIDER_UNAVAILABLE",
    retryable: true,
    ...(input.providerId ? { providerId: input.providerId } : undefined),
    ...(input.modelId ? { modelId: input.modelId } : undefined),
    ...(input.statusCode !== null
      ? { statusCode: input.statusCode }
      : undefined),
    retryCount: input.retryCount,
    ...(input.lastCompletedAction
      ? { lastCompletedAction: input.lastCompletedAction }
      : undefined),
    stepsExecuted: input.stepsExecuted,
    toolExecutionCount: input.toolExecutionCount,
    completedMutatingToolCount: input.completedMutatingToolCount,
    completedReadOnlyToolCount: input.completedReadOnlyToolCount,
    noFilesChanged: input.noFilesChanged,
    terminalState: RUN_TERMINAL_STATES.INTERRUPTED,
  };
}

function buildTaskTimeoutDetails(
  run: Run,
  error: unknown,
  context: TaskExecutionRecoveryContext,
): {
  timeoutMs: number | null;
  providerId: string | null;
  modelId: string | null;
  lastCompletedAction: string | null;
} {
  const timeoutMs = resolveTaskTimeoutMs(error);
  const providerId = sanitizeOptionalString(
    run.metadata.manifest?.providerId ?? run.input.providerId ?? null,
  );
  const modelId = sanitizeOptionalString(
    run.metadata.manifest?.modelId ?? run.input.modelId ?? null,
  );
  const lastCompletedAction = describeLastCompletedAction(
    context.stats.toolLifecycle,
  );

  return {
    timeoutMs,
    providerId,
    modelId,
    lastCompletedAction,
  };
}

function buildProviderUnavailableDetails(
  run: Run,
  error: unknown,
  context: TaskExecutionRecoveryContext,
): {
  providerId: string | null;
  modelId: string | null;
  statusCode: number | null;
  lastCompletedAction: string | null;
  retryCount: number;
  stepsExecuted: number;
  toolExecutionCount: number;
  completedMutatingToolCount: number;
  completedReadOnlyToolCount: number;
  noFilesChanged: boolean;
  signal: string;
} {
  return {
    providerId: sanitizeOptionalString(
      run.metadata.manifest?.providerId ?? run.input.providerId ?? null,
    ),
    modelId: sanitizeOptionalString(
      run.metadata.manifest?.modelId ?? run.input.modelId ?? null,
    ),
    statusCode: resolveProviderStatusCode(error),
    lastCompletedAction: describeLastCompletedAction(
      context.stats.toolLifecycle,
    ),
    retryCount: resolveProviderRetryCount(error, context.stats.llmRetryCount),
    stepsExecuted: context.stats.stepsExecuted,
    toolExecutionCount: context.stats.toolExecutionCount,
    completedMutatingToolCount: context.stats.completedMutatingToolCount,
    completedReadOnlyToolCount: context.stats.completedReadOnlyToolCount,
    noFilesChanged: context.stats.completedMutatingToolCount === 0,
    signal: getBoundedErrorSignal(error),
  };
}

function resolveProviderRetryCount(
  error: unknown,
  loopRetryCount: number,
): number {
  return (
    readNestedFiniteNumber(error, "retryCount") ??
    readNestedFiniteNumber(error, "attempts") ??
    loopRetryCount
  );
}

function resolveTaskTimeoutMs(error: unknown): number | null {
  if (error instanceof LLMTimeoutError) {
    return error.timeoutMs;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  const timeoutMatch = error.message.match(/timed out after\s+(\d+)ms/i);
  if (!timeoutMatch?.[1]) {
    return null;
  }

  const parsed = Number.parseInt(timeoutMatch[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveProviderStatusCode(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const statusCodes = collectErrorStatusCodes(error);
  return statusCodes[0] ?? null;
}

function collectErrorStatusCodes(error: Error): number[] {
  const statusCodes: number[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 6) {
    if (current instanceof Error) {
      const statusCode = readStatusCode(current);
      if (statusCode !== null) {
        statusCodes.push(statusCode);
      }
      current = (current as { cause?: unknown }).cause;
      depth += 1;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const statusCode = readStatusCode(current);
      if (statusCode !== null) {
        statusCodes.push(statusCode);
      }
    }
    break;
  }

  return statusCodes;
}

function readStatusCode(value: unknown): number | null {
  return readFiniteNumberProperty(value, "statusCode");
}

function readNestedFiniteNumber(value: unknown, key: string): number | null {
  let current: unknown = value;
  let depth = 0;

  while (current && depth < 6) {
    const numberValue = readFiniteNumberProperty(current, key);
    if (numberValue !== null) {
      return numberValue;
    }
    if (current instanceof Error || typeof current === "object") {
      current = (current as { cause?: unknown }).cause;
      depth += 1;
      continue;
    }
    break;
  }

  return null;
}

function readFiniteNumberProperty(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const numericValue = (value as Record<string, unknown>)[key];
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
    return null;
  }
  return numericValue;
}

function sanitizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getErrorSignalText(error: Error): string {
  const segments: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 6) {
    if (current instanceof Error) {
      segments.push(current.message ?? "");
      current = (current as { cause?: unknown }).cause;
      depth += 1;
      continue;
    }
    if (typeof current === "string") {
      segments.push(current);
      break;
    }
    if (typeof current === "object" && current !== null) {
      try {
        segments.push(JSON.stringify(current));
      } catch {
        segments.push(String(current));
      }
      break;
    }
    segments.push(String(current));
    break;
  }

  return segments.join(" | ").toLowerCase();
}

function getBoundedErrorSignal(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  const signal = getErrorSignalText(error).replace(/\s+/g, " ").trim();
  if (!signal) {
    return "unknown";
  }
  if (signal.length <= MAX_ERROR_SIGNAL_LENGTH) {
    return signal;
  }
  return `${signal.slice(0, MAX_ERROR_SIGNAL_LENGTH)}...`;
}

function formatModelLabel(
  providerId: string | null,
  modelId: string | null,
): string | null {
  if (providerId && modelId) {
    return `${providerId} / ${modelId}`;
  }
  return providerId ?? modelId;
}

function describeLastCompletedAction(
  toolLifecycle: TaskExecutionRecoveryContext["stats"]["toolLifecycle"],
): string | null {
  const latestCompletedEvent = [...toolLifecycle]
    .reverse()
    .find((event) => event.status === "completed");
  if (!latestCompletedEvent) {
    return null;
  }

  const displayText = sanitizeOptionalString(
    latestCompletedEvent.metadata?.displayText,
  );
  const baseAction = displayText ?? latestCompletedEvent.toolName;
  const detail = sanitizeOptionalString(latestCompletedEvent.detail);
  if (!detail) {
    return baseAction;
  }

  const compactDetail =
    detail.length <= 96 ? detail : `${detail.slice(0, 93).trimEnd()}...`;
  return `${baseAction} (${compactDetail})`;
}

function buildTerminalLlmIssueFromError(
  error: LLMUnusableResponseError,
  llmRetryCount: number,
): NonNullable<Run["metadata"]["agenticLoop"]>["terminalLlmIssue"] {
  return {
    type: "unusable_response",
    providerId: error.providerId,
    modelId: error.modelId,
    anomalyCode: error.anomalyCode,
    finishReason: error.finishReason,
    statusCode: error.statusCode,
    attempts: llmRetryCount + 1,
  };
}

function buildUnusableResponseErrorMetadata(
  error: LLMUnusableResponseError,
  terminalLlmIssue:
    | NonNullable<Run["metadata"]["agenticLoop"]>["terminalLlmIssue"]
    | undefined,
): string {
  const attempts = terminalLlmIssue?.attempts ?? 2;
  const finishReason =
    terminalLlmIssue?.finishReason ?? error.finishReason ?? "unknown";
  const statusCode = terminalLlmIssue?.statusCode ?? error.statusCode;
  const suffix =
    typeof statusCode === "number"
      ? ` finishReason=${finishReason} statusCode=${statusCode}`
      : ` finishReason=${finishReason}`;

  return `TASK_MODEL_NO_ACTION: Unusable model response after ${attempts} attempt(s). provider=${error.providerId} model=${error.modelId} anomaly=${error.anomalyCode}${suffix}`;
}

function buildProviderUnavailableErrorMetadata(input: {
  providerId: string | null;
  modelId: string | null;
  statusCode: number | null;
  signal: string;
}): string {
  const statusCodeSuffix =
    typeof input.statusCode === "number"
      ? ` statusCode=${input.statusCode}`
      : "";
  const providerSuffix =
    input.providerId && input.modelId
      ? ` provider=${input.providerId} model=${input.modelId}`
      : input.providerId
        ? ` provider=${input.providerId}`
        : input.modelId
          ? ` model=${input.modelId}`
          : "";

  return `PROVIDER_UNAVAILABLE: Provider request failed after retries.${providerSuffix}${statusCodeSuffix} signal=${input.signal}`;
}
