import type { ProviderErrorCode } from "@repo/shared-types";
import { ProviderModelDiscoveryError } from "@repo/provider-core/discovery";

/**
 * Domain error taxonomy for Brain.
 *
 * Single Responsibility: Define typed, categorized errors for consistent
 * error handling and mapping across application layers.
 *
 * All errors include:
 * - code: Machine-readable error code for categorization
 * - message: Human-readable error message
 * - retryable: Whether the operation can be safely retried
 * - correlationId: For request tracing
 */

/**
 * Base domain error with standardized properties.
 */
export class DomainError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly correlationId?: string;
  public readonly metadata?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number = 500,
    retryable: boolean = false,
    correlationId?: string,
    metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.correlationId = correlationId;
    this.metadata = metadata;
    this.name = this.constructor.name;
  }
}

/**
 * Validation error: malformed request, invalid schema, out-of-range values.
 */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    code: string = "VALIDATION_ERROR",
    correlationId?: string,
  ) {
    super(code, message, 400, false, correlationId);
  }
}

/**
 * Policy error: request violates business rules or constraints.
 * Examples: agent type not supported, fallback disabled, mode incompatible.
 */
export class PolicyError extends DomainError {
  constructor(
    message: string,
    code: string = "POLICY_ERROR",
    correlationId?: string,
  ) {
    super(code, message, 400, false, correlationId);
  }
}

/**
 * Dependency error: external service unavailable, connection failed.
 */
export class DependencyError extends DomainError {
  constructor(
    message: string,
    code: string = "DEPENDENCY_ERROR",
    retryable: boolean = true,
    correlationId?: string,
  ) {
    super(code, message, 503, retryable, correlationId);
  }
}

/**
 * Provider error: provider connection failed, invalid credentials, model not found.
 */
export class ProviderError extends DomainError {
  constructor(
    message: string,
    code: string = "PROVIDER_ERROR",
    status: number = 400,
    retryable: boolean = false,
    correlationId?: string,
  ) {
    super(code, message, status, retryable, correlationId);
  }
}

/**
 * Provider not connected error: provider credentials not configured or missing.
 * Occurs when a provider is requested but not connected via BYOK.
 */
export class ProviderNotConnectedError extends ProviderError {
  constructor(
    providerId: string,
    correlationId?: string,
  ) {
    super(
      `Provider "${providerId}" is not connected. Please connect the provider first.`,
      "PROVIDER_NOT_CONNECTED",
      400,
      false,
      correlationId,
    );
  }
}

/**
 * Model not allowed error: requested model not available or not configured.
 * Occurs when a model is requested but not available for the selected provider.
 */
export class ModelNotAllowedError extends ProviderError {
  constructor(
    model: string,
    providerId: string,
    correlationId?: string,
  ) {
    super(
      `Model "${model}" is not allowed or not configured for provider "${providerId}".`,
      "MODEL_NOT_ALLOWED",
      400,
      false,
      correlationId,
    );
  }
}

/**
 * Invalid provider selection error: provider ID is not recognized.
 * Occurs when an unknown provider is specified.
 */
export class InvalidProviderSelectionError extends ProviderError {
  constructor(
    providerId: string,
    correlationId?: string,
  ) {
    super(
      `Invalid provider selection: "${providerId}" is not a recognized provider.`,
      "INVALID_PROVIDER_SELECTION",
      400,
      false,
      correlationId,
    );
  }
}

/**
 * Not found error: resource does not exist.
 */
export class NotFoundError extends DomainError {
  constructor(
    message: string,
    code: string = "NOT_FOUND",
    correlationId?: string,
  ) {
    super(code, message, 404, false, correlationId);
  }
}

/**
 * Parse error: malformed JSON, unparseable body.
 */
export class ParseError extends DomainError {
  constructor(
    message: string,
    code: string = "PARSE_ERROR",
    correlationId?: string,
  ) {
    super(code, message, 400, false, correlationId);
  }
}

export interface AxisQuotaErrorMetadata {
  used: number;
  limit: number;
  resetsAt: string;
}

export class AxisDailyLimitExceededError extends DomainError {
  constructor(
    details: AxisQuotaErrorMetadata,
    correlationId?: string,
  ) {
    super(
      "AXIS_DAILY_LIMIT_EXCEEDED",
      `Axis free-tier daily limit exceeded (${details.used}/${details.limit}). Retry after ${details.resetsAt}.`,
      429,
      false,
      correlationId,
      {
        used: details.used,
        limit: details.limit,
        resetsAt: details.resetsAt,
      },
    );
  }
}

/**
 * Type guard: check if an error is a domain error with typed properties.
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError || error instanceof ProviderModelDiscoveryError;
}

/**
 * Map domain errors to HTTP response details.
 * Used by controllers to convert typed domain errors to standardized HTTP responses.
 *
 * @param error - The domain error to map
 * @returns { status, code, message } for HTTP response
 */
export function mapDomainErrorToHttp(error: DomainError): {
  status: number;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
} {
  return {
    status: error.status,
    code: error.code,
    message: error.message,
    metadata: error.metadata,
  };
}

export interface NormalizedProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  correlationId?: string;
}

export function normalizeProviderErrorCode(
  code: string | undefined,
  status: number,
): ProviderErrorCode {
  if (
    code === "AUTH_FAILED" ||
    code === "MODEL_NOT_ALLOWED" ||
    code === "RATE_LIMITED" ||
    code === "AXIS_DAILY_LIMIT_EXCEEDED" ||
    code === "PROVIDER_NOT_CONNECTED" ||
    code === "INVALID_PROVIDER_SELECTION" ||
    code === "PROVIDER_UNAVAILABLE" ||
    code === "VALIDATION_ERROR" ||
    code === "INTERNAL_ERROR"
  ) {
    return code;
  }

  if (status === 401 || status === 403) {
    return "AUTH_FAILED";
  }
  if (status === 429) {
    return "RATE_LIMITED";
  }
  if (status === 503) {
    return "PROVIDER_UNAVAILABLE";
  }
  if (
    code === "PARSE_ERROR" ||
    code === "PARTIAL_OVERRIDE" ||
    (typeof code === "string" && code.startsWith("MISSING_"))
  ) {
    return "VALIDATION_ERROR";
  }

  return "INTERNAL_ERROR";
}

export function toNormalizedProviderError(
  error: unknown,
  fallbackCorrelationId?: string,
): NormalizedProviderError {
  if (isDomainError(error)) {
    return {
      code: normalizeProviderErrorCode(error.code, error.status),
      message: error.message,
      retryable: error.retryable || error.status >= 500,
      correlationId: error.correlationId ?? fallbackCorrelationId,
    };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message || "Internal server error",
      retryable: true,
      correlationId: fallbackCorrelationId,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Internal server error",
    retryable: true,
    correlationId: fallbackCorrelationId,
  };
}
