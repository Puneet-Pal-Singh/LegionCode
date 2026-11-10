type ProviderModelDiscoveryErrorCode =
  | "MODEL_DISCOVERY_AUTH_FAILED"
  | "MODEL_DISCOVERY_PROVIDER_API_FAILED"
  | "MODEL_DISCOVERY_NORMALIZATION_FAILED"
  | "MODEL_DISCOVERY_CACHE_FAILED";

export abstract class ProviderModelDiscoveryError extends Error {
  protected constructor(
    public readonly code: ProviderModelDiscoveryErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ProviderModelDiscoveryAuthError extends ProviderModelDiscoveryError {
  constructor(message: string, correlationId?: string) {
    super("MODEL_DISCOVERY_AUTH_FAILED", message, 401, false, correlationId);
  }
}

export class ProviderModelDiscoveryApiError extends ProviderModelDiscoveryError {
  constructor(
    message: string,
    options?: {
      status?: number;
      retryable?: boolean;
      correlationId?: string;
    },
  ) {
    super(
      "MODEL_DISCOVERY_PROVIDER_API_FAILED",
      message,
      options?.status ?? 502,
      options?.retryable ?? true,
      options?.correlationId,
    );
  }
}

export class ProviderModelNormalizationError extends ProviderModelDiscoveryError {
  constructor(message: string, correlationId?: string) {
    super(
      "MODEL_DISCOVERY_NORMALIZATION_FAILED",
      message,
      500,
      false,
      correlationId,
    );
  }
}

export class ProviderModelCacheError extends ProviderModelDiscoveryError {
  constructor(message: string, correlationId?: string) {
    super("MODEL_DISCOVERY_CACHE_FAILED", message, 503, true, correlationId);
  }
}
