import {
  BYOKErrorCodeSchema,
  BYOKErrorEnvelopeSchema,
  type BYOKErrorCode,
  type BYOKErrorEnvelope,
} from "./types.js";
import { isRetryableError } from "@repo/shared-types";
import type { ProviderLifecycleStep } from "./state-machine.js";

export type ProviderClientOperationErrorCode =
  | BYOKErrorCode
  | "ABORTED"
  | "NETWORK_ERROR"
  | "MISSING_RUN_ID"
  | "INVALID_REQUEST_CONTRACT"
  | "INVALID_RESPONSE_CONTRACT"
  | "INVALID_RESPONSE_FORMAT"
  | "INVALID_ERROR_RESPONSE"
  | "API_ERROR"
  | "INVALID_TRANSITION"
  | "UNKNOWN_OPERATION_ERROR";

export class ProviderClientContractError extends Error {
  constructor(
    public readonly phase: "request" | "response",
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderClientContractError";
  }
}

export class ProviderClientOperationError extends Error {
  constructor(
    public readonly code: ProviderClientOperationErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderClientOperationError";
  }

  static fromEnvelope(envelope: BYOKErrorEnvelope): ProviderClientOperationError {
    const { error } = envelope;
    const retryable =
      error.retryable || isRetryableProviderClientErrorCode(error.code);
    return new ProviderClientOperationError(
      error.code,
      error.message,
      retryable,
      error.correlationId,
    );
  }
}

export class ProviderClientTransitionError extends ProviderClientOperationError {
  constructor(
    public readonly fromStep: ProviderLifecycleStep,
    public readonly toStep: ProviderLifecycleStep,
    reason: string,
  ) {
    super("INVALID_TRANSITION", reason, false);
    this.name = "ProviderClientTransitionError";
  }
}

export function isRetryableProviderClientErrorCode(
  code: ProviderClientOperationErrorCode,
): boolean {
  if (code === "ABORTED" || code === "NETWORK_ERROR") {
    return true;
  }
  if (
    code === "INVALID_TRANSITION" ||
    code === "UNKNOWN_OPERATION_ERROR" ||
    code === "MISSING_RUN_ID" ||
    code === "INVALID_REQUEST_CONTRACT" ||
    code === "INVALID_RESPONSE_CONTRACT" ||
    code === "INVALID_RESPONSE_FORMAT" ||
    code === "INVALID_ERROR_RESPONSE" ||
    code === "API_ERROR"
  ) {
    return false;
  }
  return isRetryableError(code);
}

export function normalizeProviderClientOperationError(
  error: unknown,
  operation: string,
): ProviderClientOperationError {
  if (error instanceof ProviderClientOperationError) {
    return error;
  }
  const fromEnvelope = parseProviderErrorEnvelope(error);
  if (fromEnvelope) {
    return ProviderClientOperationError.fromEnvelope(fromEnvelope);
  }
  if (isAbortError(error)) {
    return new ProviderClientOperationError(
      "ABORTED",
      "Operation aborted",
      true,
      undefined,
      0,
    );
  }
  if (isNetworkError(error)) {
    return new ProviderClientOperationError(
      "NETWORK_ERROR",
      `${operation}: ${getErrorMessage(error)}`,
      true,
      undefined,
      0,
    );
  }

  const normalizedMessage = getErrorMessage(error);
  return new ProviderClientOperationError(
    "UNKNOWN_OPERATION_ERROR",
    `${operation}: ${normalizedMessage}`,
    false,
    undefined,
    500,
  );
}

export function isProviderErrorEnvelope(
  payload: unknown,
): payload is BYOKErrorEnvelope {
  return BYOKErrorEnvelopeSchema.safeParse(payload).success;
}

export function parseProviderErrorEnvelope(
  payload: unknown,
): BYOKErrorEnvelope | null {
  const parsed = BYOKErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError";
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TypeError") {
    return true;
  }
  const lowerMessage = error.message.toLowerCase();
  return (
    lowerMessage.includes("network") ||
    lowerMessage.includes("failed to fetch") ||
    lowerMessage.includes("econn")
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Provider operation failed";
}

export function parseProviderOperationErrorCode(
  value: string,
): ProviderClientOperationErrorCode {
  const parsed = BYOKErrorCodeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  if (
    value === "ABORTED" ||
    value === "NETWORK_ERROR" ||
    value === "MISSING_RUN_ID" ||
    value === "INVALID_REQUEST_CONTRACT" ||
    value === "INVALID_RESPONSE_CONTRACT" ||
    value === "INVALID_RESPONSE_FORMAT" ||
    value === "INVALID_ERROR_RESPONSE" ||
    value === "API_ERROR"
  ) {
    return value;
  }

  if (value === "INVALID_TRANSITION") {
    return value;
  }

  return "UNKNOWN_OPERATION_ERROR";
}
