import { describe, expect, it } from "vitest";
import { APICallError, RetryError } from "ai";
import { normalizeProviderGenerationError } from "./ProviderGenerationError";

describe("normalizeProviderGenerationError", () => {
  it("unwraps AI SDK retries and preserves safe HTTP diagnostics", () => {
    const apiError = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    const retryError = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError],
    });

    const error = normalizeProviderGenerationError({
      error: retryError,
      providerId: "openrouter",
      modelId: "poolside/laguna-s-2.1:free",
    });

    expect(error.statusCode).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("provider adapter boundary");
    expect(error.message).toContain("status=400");
    expect(error.message).not.toContain("https://");
  });
});
