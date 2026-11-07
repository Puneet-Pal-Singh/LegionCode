import {
  toPublicProtocolError,
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
  "approval_timed_out",
  "invalid_approval_grant_scope",
  "approval_retry_required",
  "invalid_approval_item",
  "approval_not_active",
  "approval_already_active",
  "approval_resolution_conflict",
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
  try {
    if (error instanceof RuntimeKernelError) {
      const code = readErrorData(error, "code");
      if (!RUNTIME_KERNEL_ERROR_CODES.some((known) => known === code))
        return toPublicProtocolError(null);
      if (code === "worker_failed") {
        return mapWorkerFailure(readErrorData(error, "causeError"));
      }
      if (code === "provider_failed") {
        return mapProviderFailure(readErrorData(error, "causeError"));
      }
      return toPublicProtocolError({
        code: mapProtocolErrorCode(code as RuntimeKernelErrorCode),
        retryable: isRetryable(code as RuntimeKernelErrorCode),
      });
    }
  } catch {
    // instanceof and descriptor lookup can both fail on a hostile Proxy.
  }
  return toPublicProtocolError(null);
}

function mapProviderFailure(cause: unknown): ProtocolError {
  const statusCode = readProviderStatusCode(cause);
  return toPublicProtocolError({
    code: statusCode === 429 ? "rate_limited" : "provider_unavailable",
    retryable: true,
    details: statusCode !== null ? { providerStatusCode: statusCode } : null,
  });
}

function readProviderStatusCode(error: unknown): number | null {
  try {
    const visited = new Set<unknown>();
    let current = error;
    let depth = 0;
    while (current && depth < 8 && !visited.has(current)) {
      visited.add(current);
      if (typeof current !== "object") break;
      const statusCode = readErrorData(current, "statusCode");
      if (typeof statusCode === "number" && Number.isInteger(statusCode) &&
        statusCode >= 100 && statusCode <= 599) return statusCode;
      current = readErrorData(current, "causeError") ?? readErrorData(current, "cause") ??
        readErrorData(current, "lastError") ?? readErrorData(current, "error");
      depth += 1;
    }
  } catch {
    // No diagnostic from an accessor or Proxy is public status evidence.
  }
  return null;
}

function readErrorData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function mapWorkerFailure(cause: unknown): ProtocolError {
  return toPublicProtocolError(cause, {
    code: "command_failed",
    retryable: true,
  });
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
    case "approval_timed_out":
      return "policy_denied";
    case "approval_retry_required":
      return "approval_required";
    case "invalid_approval_item":
    case "invalid_approval_grant_scope":
    case "approval_not_active":
    case "approval_already_active":
    case "approval_resolution_conflict":
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
