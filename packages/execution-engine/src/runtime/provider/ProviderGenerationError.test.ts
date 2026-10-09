import { describe, expect, it } from "vitest";
import { APICallError, RetryError } from "ai";
import { normalizeProviderGenerationError } from "./ProviderGenerationError.js";

describe("normalizeProviderGenerationError", () => {
  it("unwraps retries and preserves only an allowlisted status", () => {
    const apiError = new APICallError({
      message: "Provider returned error with body private-body key-secret-123456789012",
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
    expect(error.code).toBe("provider_request_failed");
    expect(error.message).toBe(
      "Provider request failed (code=provider_request_failed, status=400).",
    );
    expect(error.message).not.toContain("https://");
    expect(error.message).not.toContain("private-body");
    expect(error.message).not.toContain("key-secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("drops unexpected provider status codes", () => {
    const error = normalizeProviderGenerationError({
      error: new APICallError({
        message: "payload includes sk-secret-123456789012",
        url: "https://example.test",
        requestBodyValues: {},
        statusCode: 418,
      }),
      providerId: "openrouter",
      modelId: "model-secret",
    });

    expect(error.statusCode).toBeNull();
    expect(error.message).toContain("status=unknown");
    expect(error.message).not.toContain("secret");
  });
});
