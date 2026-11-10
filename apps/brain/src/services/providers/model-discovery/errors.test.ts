import { describe, expect, it } from "vitest";
import { mapDomainErrorToHttp } from "../../../domain/errors";
import {
  ProviderModelCacheError,
  ProviderModelDiscoveryApiError,
  ProviderModelDiscoveryAuthError,
  ProviderModelNormalizationError,
} from "@repo/provider-core/discovery";

describe("provider model discovery errors", () => {
  it("maps auth error to 401", () => {
    const error = new ProviderModelDiscoveryAuthError("Invalid provider key");
    expect(error.code).toBe("MODEL_DISCOVERY_AUTH_FAILED");
    expect(mapDomainErrorToHttp(error).status).toBe(401);
  });

  it("maps provider API error to retryable dependency failure", () => {
    const error = new ProviderModelDiscoveryApiError("Provider request failed");
    expect(error.code).toBe("MODEL_DISCOVERY_PROVIDER_API_FAILED");
    expect(error.retryable).toBe(true);
    expect(mapDomainErrorToHttp(error).status).toBe(502);
  });

  it("maps normalization error to non-retryable 500", () => {
    const error = new ProviderModelNormalizationError("Invalid provider payload");
    expect(error.code).toBe("MODEL_DISCOVERY_NORMALIZATION_FAILED");
    expect(error.retryable).toBe(false);
    expect(mapDomainErrorToHttp(error).status).toBe(500);
  });

  it("maps cache error to retryable 503", () => {
    const error = new ProviderModelCacheError("Cache operation failed");
    expect(error.code).toBe("MODEL_DISCOVERY_CACHE_FAILED");
    expect(error.retryable).toBe(true);
    expect(mapDomainErrorToHttp(error).status).toBe(503);
  });
});
