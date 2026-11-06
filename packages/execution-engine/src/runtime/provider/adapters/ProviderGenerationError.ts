import { APICallError, RetryError } from "ai";

export class ProviderGenerationError extends Error {
  readonly providerId: string;
  readonly modelId: string;
  readonly statusCode: number | null;
  readonly retryable: boolean | null;

  constructor(input: {
    providerId: string;
    modelId: string;
    statusCode: number | null;
    retryable: boolean | null;
    detail: string;
    cause: unknown;
  }) {
    const status = input.statusCode === null ? "unknown" : input.statusCode;
    super(
      `Model request failed at the provider adapter boundary (provider=${input.providerId}, model=${input.modelId}, status=${status}): ${input.detail}`,
      { cause: input.cause },
    );
    this.name = "ProviderGenerationError";
    this.providerId = input.providerId;
    this.modelId = input.modelId;
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
  const detail =
    rootError instanceof Error && rootError.message.trim()
      ? rootError.message.trim()
      : "Unknown adapter failure";

  return new ProviderGenerationError({
    providerId: input.providerId,
    modelId: input.modelId,
    statusCode: apiError?.statusCode ?? null,
    retryable: apiError?.isRetryable ?? null,
    detail: sanitizeDetail(detail),
    cause: input.error,
  });
}

function sanitizeDetail(detail: string): string {
  return detail
    .replace(/\s+/g, " ")
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, 240);
}
