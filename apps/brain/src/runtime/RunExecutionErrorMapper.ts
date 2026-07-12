import { DomainError, isDomainError } from "../domain/errors";
import { ProviderCapabilityError } from "@shadowbox/execution-engine/runtime";
import {
  SecureExecutionContractViolationError,
  SecureExecutionFailureError,
} from "../services/secure-execution/SecureExecutionContract";

const RUN_MANIFEST_IMMUTABLE_CODE = "RUN_MANIFEST_IMMUTABLE";
const RUN_MANIFEST_IMMUTABLE_STATUS = 409;
const RUN_MANIFEST_MISMATCH_SENTINEL = "Immutable run manifest mismatch";
const RUN_MANIFEST_IMMUTABLE_MESSAGE =
  "Run selection is immutable while a run is active. Wait for completion (or cancel the active run), then change provider/model/harness/orchestrator.";
const PLAN_SCHEMA_MISMATCH_CODE = "PLAN_SCHEMA_MISMATCH";
const PLAN_SCHEMA_MISMATCH_STATUS = 422;
const PLAN_SCHEMA_MISMATCH_MESSAGE =
  "The model could not produce a valid structured execution plan for this request. Retry with a more concrete path/command, or use a model that supports structured planning reliably.";
const PLAN_GENERATION_TIMEOUT_CODE = "PLAN_GENERATION_TIMEOUT";
const PLAN_GENERATION_TIMEOUT_STATUS = 504;
const PLAN_GENERATION_TIMEOUT_MESSAGE =
  "Planning timed out before executable tasks could be generated. Retry with a narrower request.";
const TASK_EXECUTION_TIMEOUT_CODE = "TASK_EXECUTION_TIMEOUT";
const TASK_EXECUTION_TIMEOUT_STATUS = 504;
const TASK_EXECUTION_TIMEOUT_MESSAGE =
  "The model timed out before choosing the next action. Retry the task or switch to a faster or more reliable model.";
const PLAN_SCHEMA_MISMATCH_SENTINEL =
  "No object generated: response did not match schema";
const PLANNER_SCHEMA_MISMATCH_SENTINEL =
  "Planner response did not match required schema";
const PLAN_TIMEOUT_SENTINEL = "Planner request timed out";
const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";
const PROVIDER_UNAVAILABLE_STATUS = 503;
const PROVIDER_UNAVAILABLE_MESSAGE =
  "Provider request failed after retries. Verify provider/model availability, then retry.";
const PROVIDER_RATE_LIMITED_CODE = "RATE_LIMITED";
const PROVIDER_RATE_LIMITED_STATUS = 429;
const PROVIDER_RATE_LIMITED_MESSAGE =
  "Provider rate limit reached. Retry after a short cooldown or switch providers.";
const PROVIDER_AUTH_FAILED_CODE = "AUTH_FAILED";
const PROVIDER_AUTH_FAILED_STATUS = 401;
const PROVIDER_AUTH_FAILED_MESSAGE =
  "Provider authentication failed. Reconnect credentials in Provider Settings and retry.";
const TOOLS_NOT_SUPPORTED_CODE = "TOOLS_NOT_SUPPORTED";
const TOOLS_NOT_SUPPORTED_STATUS = 422;
const TOOLS_NOT_SUPPORTED_MESSAGE =
  "The selected model cannot use tools for this request. Switch to a tool-capable model and retry.";
const STRUCTURED_OUTPUTS_NOT_SUPPORTED_CODE =
  "STRUCTURED_OUTPUTS_NOT_SUPPORTED";
const STRUCTURED_OUTPUTS_NOT_SUPPORTED_STATUS = 422;
const STRUCTURED_OUTPUTS_NOT_SUPPORTED_MESSAGE =
  "The selected model cannot produce the structured output required for planning. Switch to a structured-output model and retry.";
const EXECUTION_LANE_UNSUPPORTED_CODE = "EXECUTION_LANE_UNSUPPORTED";
const EXECUTION_LANE_UNSUPPORTED_STATUS = 422;
const EXECUTION_LANE_UNSUPPORTED_ACTION_MESSAGE =
  "The selected provider/model pair cannot satisfy the tool-calling requirements for this execution turn. Choose a tool-capable model and retry.";
const EXECUTION_LANE_UNSUPPORTED_PLANNING_MESSAGE =
  "The selected provider/model pair cannot satisfy the structured-planning requirements for this request. Choose a model with tool-calling and structured-output support, then retry.";
const EXECUTION_LANE_UNSUPPORTED_DEFAULT_MESSAGE =
  "The selected provider/model pair cannot satisfy the required execution lane for this request. Choose a compatible model and retry.";
const INVALID_PROVIDER_SELECTION_CODE = "INVALID_PROVIDER_SELECTION";
const INVALID_PROVIDER_SELECTION_STATUS = 400;
const INVALID_PROVIDER_SELECTION_MESSAGE =
  "Provider or model selection is invalid for runtime execution. Choose a registered provider and concrete model, then retry.";
const MODEL_NOT_ALLOWED_CODE = "MODEL_NOT_ALLOWED";
const MODEL_NOT_ALLOWED_STATUS = 400;
const MODEL_NOT_ALLOWED_MESSAGE =
  "The selected model is not allowed for the chosen provider. Pick an allowed model and retry.";
const SECURE_SANDBOX_UNAVAILABLE_CODE = "SANDBOX_UNAVAILABLE";
const SECURE_EXECUTION_FAILED_CODE = "SECURE_EXECUTION_FAILED";
const SECURE_EXECUTION_TIMEOUT_CODE = "EXECUTION_TIMEOUT";
const SECURE_EXECUTION_CANCELLED_CODE = "EXECUTION_CANCELLED";
const SECURE_CONTRACT_VIOLATION_CODE = "SECURE_EXECUTION_CONTRACT_VIOLATION";

type MessageResolver = string | ((error: ProviderCapabilityError) => string);

interface ProviderCapabilityMapping {
  domainCode: string;
  status: number;
  retryable: boolean;
  message: MessageResolver;
}

const PROVIDER_CAPABILITY_MAPPINGS: Record<
  ProviderCapabilityError["code"],
  ProviderCapabilityMapping
> = {
  INVALID_PROVIDER_SELECTION: {
    domainCode: INVALID_PROVIDER_SELECTION_CODE,
    status: INVALID_PROVIDER_SELECTION_STATUS,
    retryable: false,
    message: INVALID_PROVIDER_SELECTION_MESSAGE,
  },
  MODEL_NOT_ALLOWED: {
    domainCode: MODEL_NOT_ALLOWED_CODE,
    status: MODEL_NOT_ALLOWED_STATUS,
    retryable: false,
    message: MODEL_NOT_ALLOWED_MESSAGE,
  },
  TOOLS_NOT_SUPPORTED: {
    domainCode: TOOLS_NOT_SUPPORTED_CODE,
    status: TOOLS_NOT_SUPPORTED_STATUS,
    retryable: false,
    message: TOOLS_NOT_SUPPORTED_MESSAGE,
  },
  STRUCTURED_OUTPUTS_NOT_SUPPORTED: {
    domainCode: STRUCTURED_OUTPUTS_NOT_SUPPORTED_CODE,
    status: STRUCTURED_OUTPUTS_NOT_SUPPORTED_STATUS,
    retryable: false,
    message: STRUCTURED_OUTPUTS_NOT_SUPPORTED_MESSAGE,
  },
  EXECUTION_LANE_UNSUPPORTED: {
    domainCode: EXECUTION_LANE_UNSUPPORTED_CODE,
    status: EXECUTION_LANE_UNSUPPORTED_STATUS,
    retryable: false,
    message: getExecutionLaneUnsupportedMessage,
  },
};

export function isProviderCapabilityError(error: unknown): boolean {
  return getProviderCapabilityError(error) !== null;
}

export function buildProviderCapabilityErrorMapping(
  error: ProviderCapabilityError,
  correlationId?: string,
): DomainError {
  return mapProviderCapabilityError(error, correlationId);
}

/**
 * Maps runtime execution failures to typed domain errors when possible.
 */
export function mapRunExecutionErrorToDomain(
  error: unknown,
  correlationId?: string,
): DomainError | null {
  if (isDomainError(error)) {
    return error;
  }

  if (error instanceof SecureExecutionFailureError) {
    return mapSecureExecutionFailure(error);
  }

  if (error instanceof SecureExecutionContractViolationError) {
    return new DomainError(
      SECURE_CONTRACT_VIOLATION_CODE,
      "Secure execution returned a response that violated its failure contract. Retry the run.",
      502,
      true,
      correlationId,
      { httpStatus: error.httpStatus },
    );
  }

  if (isRunManifestMismatch(error)) {
    return new DomainError(
      RUN_MANIFEST_IMMUTABLE_CODE,
      RUN_MANIFEST_IMMUTABLE_MESSAGE,
      RUN_MANIFEST_IMMUTABLE_STATUS,
      false,
      correlationId,
    );
  }

  const providerCapabilityError = getProviderCapabilityError(error);
  if (providerCapabilityError) {
    return mapProviderCapabilityError(providerCapabilityError, correlationId);
  }

  if (isPlanSchemaMismatch(error)) {
    return new DomainError(
      PLAN_SCHEMA_MISMATCH_CODE,
      PLAN_SCHEMA_MISMATCH_MESSAGE,
      PLAN_SCHEMA_MISMATCH_STATUS,
      false,
      correlationId,
    );
  }

  if (isPlanGenerationTimeout(error)) {
    return new DomainError(
      PLAN_GENERATION_TIMEOUT_CODE,
      PLAN_GENERATION_TIMEOUT_MESSAGE,
      PLAN_GENERATION_TIMEOUT_STATUS,
      true,
      correlationId,
    );
  }

  if (isTaskExecutionTimeout(error)) {
    return new DomainError(
      TASK_EXECUTION_TIMEOUT_CODE,
      TASK_EXECUTION_TIMEOUT_MESSAGE,
      TASK_EXECUTION_TIMEOUT_STATUS,
      true,
      correlationId,
    );
  }

  if (isProviderRateLimited(error)) {
    return new DomainError(
      PROVIDER_RATE_LIMITED_CODE,
      PROVIDER_RATE_LIMITED_MESSAGE,
      PROVIDER_RATE_LIMITED_STATUS,
      true,
      correlationId,
    );
  }

  if (isProviderAuthFailure(error)) {
    return new DomainError(
      PROVIDER_AUTH_FAILED_CODE,
      PROVIDER_AUTH_FAILED_MESSAGE,
      PROVIDER_AUTH_FAILED_STATUS,
      false,
      correlationId,
    );
  }

  if (isProviderUnavailable(error)) {
    return new DomainError(
      PROVIDER_UNAVAILABLE_CODE,
      PROVIDER_UNAVAILABLE_MESSAGE,
      PROVIDER_UNAVAILABLE_STATUS,
      true,
      correlationId,
    );
  }

  return null;
}

function mapSecureExecutionFailure(
  error: SecureExecutionFailureError,
): DomainError {
  const { outcome } = error;
  const secureError = outcome.error;
  const code =
    outcome.status === "sandbox_unavailable"
      ? SECURE_SANDBOX_UNAVAILABLE_CODE
      : outcome.status === "timeout"
        ? SECURE_EXECUTION_TIMEOUT_CODE
        : outcome.status === "cancelled"
          ? SECURE_EXECUTION_CANCELLED_CODE
          : SECURE_EXECUTION_FAILED_CODE;
  const status =
    outcome.status === "timeout"
      ? 504
      : outcome.status === "cancelled"
        ? 499
        : outcome.status === "sandbox_unavailable"
          ? 503
          : 422;
  const retryable = outcome.status === "cancelled" ? false : outcome.retryable;
  return new DomainError(
    code,
    secureError?.message ?? `Secure execution ${outcome.status}`,
    status,
    retryable,
    outcome.correlationId,
    {
      taskId: outcome.taskId,
      leaseId: outcome.leaseId,
      secureStatus: outcome.status,
      secureCode: secureError?.code,
      secureDetails: secureError?.details,
      httpStatus: error.httpStatus,
      plugin: error.context?.plugin,
      action: error.context?.action,
      runId: error.context?.runId,
      workspaceScope: error.context?.workspaceScope,
    },
  );
}

function mapProviderCapabilityError(
  error: ProviderCapabilityError,
  correlationId?: string,
): DomainError {
  const metadata = buildProviderCapabilityMetadata(error);
  const mapping = PROVIDER_CAPABILITY_MAPPINGS[error.code];

  if (mapping) {
    const message =
      typeof mapping.message === "function"
        ? mapping.message(error)
        : mapping.message;

    return new DomainError(
      mapping.domainCode,
      message,
      mapping.status,
      mapping.retryable,
      correlationId,
      metadata,
    );
  }

  console.warn(
    `[run/error-mapper] Unknown provider capability error code: ${error.code}`,
  );
  return new DomainError(
    "PROVIDER_CAPABILITY_ERROR",
    `Unknown provider capability error: ${error.code}`,
    500,
    false,
    correlationId,
    metadata,
  );
}

function isRunManifestMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "RunManifestMismatchError" &&
    error.message.includes(RUN_MANIFEST_MISMATCH_SENTINEL)
  );
}

function getProviderCapabilityError(
  error: unknown,
): ProviderCapabilityError | null {
  let current: unknown = error;
  let depth = 0;
  const maxDepth = 6;

  while (current !== null && current !== undefined && depth < maxDepth) {
    if (current instanceof ProviderCapabilityError) {
      return current;
    }

    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      depth += 1;
    } else {
      break;
    }
  }

  return null;
}

function isPlanSchemaMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes(PLAN_SCHEMA_MISMATCH_SENTINEL) ||
    error.message.includes(PLANNER_SCHEMA_MISMATCH_SENTINEL)
  );
}

function isPlanGenerationTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const signalText = getErrorSignalText(error);
  return (
    (error.name === "LLMTimeoutError" &&
      signalText.includes("(phase=planning)")) ||
    signalText.includes(PLAN_TIMEOUT_SENTINEL.toLowerCase())
  );
}

function isTaskExecutionTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const signalText = getErrorSignalText(error);
  return (
    (error.name === "LLMTimeoutError" && signalText.includes("(phase=task)")) ||
    signalText.includes("text call timed out") ||
    signalText.includes("task execution timed out")
  );
}

function isProviderUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const signalText = getErrorSignalText(error);

  return (
    signalText.includes("failed after 3 attempts") ||
    signalText.includes("provider returned error") ||
    signalText.includes("provider request failed") ||
    signalText.includes("service unavailable") ||
    signalText.includes("econnreset") ||
    signalText.includes("upstream")
  );
}

function isProviderRateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const signalText = getErrorSignalText(error);
  return (
    signalText.includes("rate limit") ||
    signalText.includes("too many requests") ||
    signalText.includes("status code 429") ||
    signalText.includes(" 429 ")
  );
}

function isProviderAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const signalText = getErrorSignalText(error);
  return (
    signalText.includes("unauthorized") ||
    signalText.includes("authentication failed") ||
    signalText.includes("invalid api key") ||
    signalText.includes("incorrect api key") ||
    signalText.includes("status code 401") ||
    signalText.includes(" 401 ")
  );
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

function getExecutionLaneUnsupportedMessage(
  error: ProviderCapabilityError,
): string {
  if (error.lane === "single_agent_action") {
    return EXECUTION_LANE_UNSUPPORTED_ACTION_MESSAGE;
  }
  if (error.lane === "structured_planning_required") {
    return EXECUTION_LANE_UNSUPPORTED_PLANNING_MESSAGE;
  }
  return EXECUTION_LANE_UNSUPPORTED_DEFAULT_MESSAGE;
}

function buildProviderCapabilityMetadata(
  error: ProviderCapabilityError,
): Record<string, unknown> {
  return {
    lane: error.lane,
    reason: error.reason,
  };
}
