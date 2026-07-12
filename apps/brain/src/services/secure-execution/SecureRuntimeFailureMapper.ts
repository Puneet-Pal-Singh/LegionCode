import type { JsonRecord, ProtocolError } from "@repo/platform-protocol";
import type {
  SecureExecutionFailureContext,
  SecureExecutionOutcome,
} from "./SecureExecutionContract";

export class SecureRuntimeFailureMapper {
  toRuntimeFailure(
    outcome: SecureExecutionOutcome,
    httpStatus: number,
    context?: SecureExecutionFailureContext,
  ): ProtocolError {
    const mapping = mapSecureStatus(outcome.status);
    return {
      code: mapping.code,
      message: outcome.error?.message ?? `Secure execution ${outcome.status}`,
      retryable: outcome.status === "cancelled" ? false : outcome.retryable,
      correlationId: outcome.correlationId,
      details: buildFailureDetails(outcome, httpStatus, context),
    };
  }

  toContractViolation(
    httpStatus: number,
    message: string,
    context?: SecureExecutionFailureContext,
  ): ProtocolError {
    return {
      code: "internal_error",
      message,
      retryable: true,
      correlationId: null,
      details: {
        failureKind: "secure_execution_contract_violation",
        httpStatus,
        plugin: context?.plugin ?? null,
        action: context?.action ?? null,
        runId: context?.runId ?? null,
        workspaceScope: context?.workspaceScope ?? null,
      },
    };
  }
}

function mapSecureStatus(status: SecureExecutionOutcome["status"]): {
  code: ProtocolError["code"];
} {
  switch (status) {
    case "sandbox_unavailable":
      return { code: "worker_unavailable" };
    case "timeout":
      return { code: "command_timed_out" };
    case "cancelled":
      return { code: "command_cancelled" };
    case "failure":
      return { code: "command_failed" };
    case "success":
      throw new Error(
        "A successful secure execution cannot be mapped as a failure.",
      );
  }
}

function buildFailureDetails(
  outcome: SecureExecutionOutcome,
  httpStatus: number,
  context?: SecureExecutionFailureContext,
): JsonRecord {
  return {
    secureStatus: outcome.status,
    secureCode: outcome.error?.code ?? null,
    secureDetails: toJsonValue(outcome.error?.details),
    httpStatus,
    taskId: outcome.taskId,
    leaseId: outcome.leaseId,
    secureCorrelationId: outcome.correlationId,
    plugin: context?.plugin ?? null,
    action: context?.action ?? null,
    runId: context?.runId ?? null,
    workspaceScope: context?.workspaceScope ?? null,
  };
}

function toJsonValue(value: unknown): JsonRecord[string] {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toJsonValue(entry),
      ]),
    );
  }
  return String(value);
}
