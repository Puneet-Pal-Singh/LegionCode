import {
  ProtocolErrorCodeSchema,
  ProtocolErrorSchema,
  type ProtocolError,
  type ProtocolErrorCode,
} from "@repo/platform-protocol";

export type PlatformClientOperationErrorCode =
  | ProtocolErrorCode
  | "ABORTED"
  | "NETWORK_ERROR"
  | "INVALID_REQUEST_CONTRACT"
  | "INVALID_RESPONSE_CONTRACT"
  | "INVALID_RESPONSE_FORMAT"
  | "INVALID_ERROR_RESPONSE"
  | "API_ERROR"
  | "UNKNOWN_OPERATION_ERROR";

export class PlatformClientContractError extends Error {
  constructor(
    public readonly phase: "request" | "response",
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformClientContractError";
  }
}

export class PlatformClientOperationError extends Error {
  constructor(
    public readonly code: PlatformClientOperationErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "PlatformClientOperationError";
  }

  static fromProtocolError(
    error: ProtocolError,
    statusCode?: number,
  ): PlatformClientOperationError {
    return new PlatformClientOperationError(
      error.code,
      error.message,
      error.retryable,
      error.correlationId ?? undefined,
      statusCode,
    );
  }
}

export function normalizePlatformClientOperationError(
  error: unknown,
  operation: string,
): PlatformClientOperationError {
  if (error instanceof PlatformClientOperationError) {
    return error;
  }
  const protocolError = parseProtocolErrorEnvelope(error);
  if (protocolError) {
    return PlatformClientOperationError.fromProtocolError(protocolError);
  }
  if (isAbortError(error)) {
    return new PlatformClientOperationError(
      "ABORTED",
      "Operation aborted",
      true,
      undefined,
      0,
    );
  }
  if (isNetworkError(error)) {
    return new PlatformClientOperationError(
      "NETWORK_ERROR",
      `${operation}: ${getErrorMessage(error)}`,
      true,
      undefined,
      0,
    );
  }
  return new PlatformClientOperationError(
    "UNKNOWN_OPERATION_ERROR",
    `${operation}: ${getErrorMessage(error)}`,
    false,
    undefined,
    500,
  );
}

export function parsePlatformOperationErrorCode(
  value: string,
): PlatformClientOperationErrorCode {
  const parsed = ProtocolErrorCodeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  if (isPlatformTransportErrorCode(value)) {
    return value;
  }
  return "UNKNOWN_OPERATION_ERROR";
}

export function parseProtocolErrorEnvelope(
  payload: unknown,
): ProtocolError | null {
  const direct = ProtocolErrorSchema.safeParse(payload);
  if (direct.success) {
    return direct.data;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const nested = ProtocolErrorSchema.safeParse(raw.error);
  return nested.success ? nested.data : null;
}

function isPlatformTransportErrorCode(
  value: string,
): value is Exclude<PlatformClientOperationErrorCode, ProtocolErrorCode> {
  return (
    value === "ABORTED" ||
    value === "NETWORK_ERROR" ||
    value === "INVALID_REQUEST_CONTRACT" ||
    value === "INVALID_RESPONSE_CONTRACT" ||
    value === "INVALID_RESPONSE_FORMAT" ||
    value === "INVALID_ERROR_RESPONSE" ||
    value === "API_ERROR" ||
    value === "UNKNOWN_OPERATION_ERROR"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TypeError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("network") || message.includes("failed to fetch");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Platform operation failed";
}
