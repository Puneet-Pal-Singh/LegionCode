import {
  ProtocolErrorSchema,
  type ProtocolError,
  type ProtocolErrorCode,
} from "@repo/platform-protocol";

export const RUNTIME_KERNEL_ERROR_CODES = [
  "invalid_turn_identity",
  "workspace_not_found",
  "workspace_not_executable",
  "model_final_missing",
  "provider_failed",
  "tool_loop_limit_exceeded",
  "worker_failed",
  "tool_not_registered",
  "invalid_tool_input",
  "tool_policy_denied",
  "approval_denied",
  "approval_retry_required",
  "invalid_approval_item",
  "approval_not_active",
  "approval_already_active",
  "turn_not_active",
  "turn_already_owned",
  "turn_artifact_settlement_failed",
  "turn_cancelled",
  "context_compaction_unsupported",
] as const;
export type RuntimeKernelErrorCode =
  (typeof RUNTIME_KERNEL_ERROR_CODES)[number];

export class RuntimeKernelError extends Error {
  constructor(
    readonly code: RuntimeKernelErrorCode,
    message: string,
    readonly causeError?: unknown,
  ) {
    super(message);
    this.name = "RuntimeKernelError";
  }
}

export class RuntimeLifecycleSettlementError extends Error {
  readonly code = "lifecycle_settlement_failed" as const;

  constructor(
    readonly intendedStatus: "completed" | "interrupted" | "failed",
    readonly causeError: unknown,
  ) {
    super(`Runtime lifecycle settlement failed for ${intendedStatus}`);
    this.name = "RuntimeLifecycleSettlementError";
  }
}

export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof RuntimeKernelError) {
    if (error.code === "worker_failed") {
      return mapWorkerFailure(error);
    }
    if (error.code === "provider_failed") {
      return mapProviderFailure(error);
    }
    return {
      code: mapProtocolErrorCode(error.code),
      message: error.message,
      retryable: isRetryable(error.code),
      correlationId: null,
      details: { runtimeKernelCode: error.code },
    };
  }

  return {
    code: "internal_error",
    message: "Runtime kernel turn execution failed",
    retryable: false,
    correlationId: null,
    details: null,
  };
}

function mapProviderFailure(error: RuntimeKernelError): ProtocolError {
  return {
    code: "provider_unavailable",
    message: safeRuntimeErrorMessage(error.causeError),
    retryable: true,
    correlationId: null,
    details: { runtimeKernelCode: error.code },
  };
}

function safeRuntimeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The model provider request failed.";
  const message = error.message.replace(/\s+/g, " ").trim();
  if (!message) return "The model provider request failed.";
  return message
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, 500);
}

function mapWorkerFailure(error: RuntimeKernelError): ProtocolError {
  const failure = parseWorkerFailure(error.causeError);
  if (failure === null) {
    return {
      code: "command_failed",
      message: error.message,
      retryable: true,
      correlationId: null,
      details: { runtimeKernelCode: error.code },
    };
  }
  return {
    ...failure,
    details: {
      ...(failure.details ?? {}),
      runtimeKernelCode: error.code,
    },
  };
}

function parseWorkerFailure(value: unknown): ProtocolError | null {
  const parsed = ProtocolErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapProtocolErrorCode(code: RuntimeKernelErrorCode): ProtocolErrorCode {
  switch (code) {
    case "workspace_not_found":
      return "not_found";
    case "workspace_not_executable":
    case "invalid_turn_identity":
      return "conflict";
    case "worker_failed":
      return "command_failed";
    case "provider_failed":
      return "provider_unavailable";
    case "tool_not_registered":
      return "not_found";
    case "invalid_tool_input":
    case "model_final_missing":
      return "validation_failed";
    case "tool_policy_denied":
    case "approval_denied":
      return "policy_denied";
    case "approval_retry_required":
      return "approval_required";
    case "invalid_approval_item":
    case "approval_not_active":
    case "approval_already_active":
    case "turn_not_active":
    case "turn_already_owned":
      return "conflict";
    case "tool_loop_limit_exceeded":
    case "turn_artifact_settlement_failed":
    case "context_compaction_unsupported":
      return "internal_error";
    case "turn_cancelled":
      return "conflict";
  }
}

function isRetryable(code: RuntimeKernelErrorCode): boolean {
  return (
    code === "worker_failed" ||
    code === "provider_failed" ||
    code === "approval_retry_required"
  );
}
