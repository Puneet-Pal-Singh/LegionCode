export type SecureExecutionStatus =
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "sandbox_unavailable";

export interface SecureExecutionError {
  code: string;
  message: string;
  details?: unknown;
}

export interface SecureExecutionMetrics {
  duration: number;
  memoryUsed?: number;
}

export interface SecureExecutionOutcome {
  taskId: string;
  leaseId: string;
  correlationId: string;
  status: SecureExecutionStatus;
  retryable: boolean;
  output?: string;
  error?: SecureExecutionError;
  metrics?: SecureExecutionMetrics;
}

export interface SecureExecutionFailureContext {
  plugin: string;
  action: string;
  runId: string;
  workspaceScope?: {
    runAttemptId: string;
    workspaceId: string;
    root: string;
  };
}

export class SecureExecutionFailureError extends Error {
  readonly outcome: SecureExecutionOutcome;
  readonly httpStatus: number;
  readonly context?: SecureExecutionFailureContext;

  constructor(
    outcome: SecureExecutionOutcome,
    httpStatus: number,
    context?: SecureExecutionFailureContext,
  ) {
    super(outcome.error?.message ?? `Secure execution ${outcome.status}`);
    this.name = "SecureExecutionFailureError";
    this.outcome = outcome;
    this.httpStatus = httpStatus;
    this.context = context;
  }
}

export class SecureExecutionContractViolationError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "SecureExecutionContractViolationError";
    this.httpStatus = httpStatus;
  }
}

export function parseSecureExecutionOutcome(
  value: unknown,
): SecureExecutionOutcome | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.taskId !== "string" ||
    typeof value.leaseId !== "string" ||
    typeof value.correlationId !== "string" ||
    typeof value.retryable !== "boolean" ||
    !isSecureExecutionStatus(value.status)
  ) {
    return null;
  }

  const error = value.error;
  if (error !== undefined) {
    if (
      !isRecord(error) ||
      typeof error.code !== "string" ||
      typeof error.message !== "string"
    ) {
      return null;
    }
  }

  return {
    taskId: value.taskId,
    leaseId: value.leaseId,
    correlationId: value.correlationId,
    status: value.status,
    retryable: value.retryable,
    output: typeof value.output === "string" ? value.output : undefined,
    error: error as SecureExecutionError | undefined,
    metrics:
      isRecord(value.metrics) && typeof value.metrics.duration === "number"
        ? {
            duration: value.metrics.duration,
            memoryUsed:
              typeof value.metrics.memoryUsed === "number"
                ? value.metrics.memoryUsed
                : undefined,
          }
        : undefined,
  };
}

export function isSecureExecutionStatus(
  value: unknown,
): value is SecureExecutionStatus {
  return (
    value === "success" ||
    value === "failure" ||
    value === "timeout" ||
    value === "cancelled" ||
    value === "sandbox_unavailable"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
