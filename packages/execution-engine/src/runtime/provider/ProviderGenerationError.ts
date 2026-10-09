import { APICallError, RetryError } from "ai";

const SAFE_HTTP_STATUS_CODES = new Set([
  400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504,
]);

export class ProviderGenerationError extends Error {
  readonly code = "provider_request_failed";
  readonly statusCode: number | null;
  readonly retryable: boolean | null;

  constructor(input: {
    statusCode: number | null;
    retryable: boolean | null;
  }) {
    const status = input.statusCode === null ? "unknown" : input.statusCode;
    super(`Provider request failed (code=provider_request_failed, status=${status}).`);
    this.name = "ProviderGenerationError";
    this.statusCode = input.statusCode;
    this.retryable = input.retryable;
  }
}

export function normalizeProviderGenerationError(input: {
  error: unknown;
  providerId: string;
  modelId: string;
}): ProviderGenerationError {
  const rootError = RetryError.isInstance(input.error)
    ? input.error.lastError
    : input.error;
  const apiError = APICallError.isInstance(rootError) ? rootError : null;
  return new ProviderGenerationError({
    statusCode: safeHttpStatus(apiError?.statusCode),
    retryable: apiError?.isRetryable ?? null,
  });
}

function safeHttpStatus(statusCode: number | undefined): number | null {
  return statusCode !== undefined && SAFE_HTTP_STATUS_CODES.has(statusCode)
    ? statusCode
    : null;
}
