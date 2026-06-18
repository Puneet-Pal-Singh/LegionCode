import {
  ProtocolErrorSchema,
  type ProtocolError,
  type ProtocolErrorCode,
} from "@repo/platform-protocol";

export const RUNTIME_KERNEL_ERROR_CODES = [
  "invalid_turn_identity",
  "workspace_not_found",
  "workspace_not_executable",
  "tool_loop_limit_exceeded",
  "worker_failed",
  "tool_not_registered",
  "invalid_tool_input",
  "tool_policy_denied",
  "approval_denied",
  "approval_retry_required",
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

export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof RuntimeKernelError) {
    if (error.code === "worker_failed") {
      return mapWorkerFailure(error);
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
    case "tool_not_registered":
      return "not_found";
    case "invalid_tool_input":
      return "validation_failed";
    case "tool_policy_denied":
    case "approval_denied":
      return "policy_denied";
    case "approval_retry_required":
      return "approval_required";
    case "tool_loop_limit_exceeded":
      return "internal_error";
  }
}

function isRetryable(code: RuntimeKernelErrorCode): boolean {
  return code === "worker_failed" || code === "approval_retry_required";
}
