import { describe, expect, it } from "vitest";
import {
  ProviderClientOperationError,
  ProviderClientTransitionError,
  isProviderErrorEnvelope,
  isRetryableProviderClientErrorCode,
  normalizeProviderClientOperationError,
  parseProviderOperationErrorCode,
  parseProviderErrorEnvelope,
} from "./errors.js";

describe("provider client errors", () => {
  it("parses canonical provider error envelope", () => {
    const envelope = {
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Provider is temporarily unavailable",
        retryable: true,
        correlationId: "corr-1",
      },
    };

    expect(isProviderErrorEnvelope(envelope)).toBe(true);
    expect(parseProviderErrorEnvelope(envelope)).toEqual(envelope);
  });

  it("returns null for non-conforming envelopes", () => {
    expect(isProviderErrorEnvelope({ error: "nope" })).toBe(false);
    expect(parseProviderErrorEnvelope({ error: "nope" })).toBeNull();
  });

  it("maps envelope into typed operation error", () => {
    const error = ProviderClientOperationError.fromEnvelope({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Provider unavailable",
        retryable: false,
        correlationId: "corr-2",
      },
    });

    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.correlationId).toBe("corr-2");
  });

  it("classifies retryable and non-retryable codes deterministically", () => {
    expect(isRetryableProviderClientErrorCode("PROVIDER_UNAVAILABLE")).toBe(
      true,
    );
    expect(isRetryableProviderClientErrorCode("PROVIDER_AUTH_FAILED")).toBe(
      false,
    );
    expect(isRetryableProviderClientErrorCode("NETWORK_ERROR")).toBe(true);
    expect(isRetryableProviderClientErrorCode("INVALID_TRANSITION")).toBe(
      false,
    );
  });

  it("normalizes unknown errors into typed operation errors", () => {
    const normalized = normalizeProviderClientOperationError(
      new Error("boom"),
      "connectCredential",
    );

    expect(normalized).toBeInstanceOf(ProviderClientOperationError);
    expect(normalized.code).toBe("UNKNOWN_OPERATION_ERROR");
    expect(normalized.retryable).toBe(false);
    expect(normalized.message).toContain("connectCredential");
  });

  it("normalizes network failures into retryable network errors", () => {
    const normalized = normalizeProviderClientOperationError(
      new TypeError("Failed to fetch"),
      "discoverProviders",
    );

    expect(normalized.code).toBe("NETWORK_ERROR");
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain("discoverProviders");
  });

  it("parses operation error code fallback values", () => {
    expect(parseProviderOperationErrorCode("PROVIDER_AUTH_FAILED")).toBe(
      "PROVIDER_AUTH_FAILED",
    );
    expect(parseProviderOperationErrorCode("ABORTED")).toBe("ABORTED");
    expect(parseProviderOperationErrorCode("INVALID_TRANSITION")).toBe(
      "INVALID_TRANSITION",
    );
    expect(parseProviderOperationErrorCode("something_else")).toBe(
      "UNKNOWN_OPERATION_ERROR",
    );
  });

  it("uses non-retryable typed transition errors", () => {
    const error = new ProviderClientTransitionError(
      "discover_providers",
      "resolve_for_run",
      "invalid transition",
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.retryable).toBe(false);
    expect(error.fromStep).toBe("discover_providers");
    expect(error.toStep).toBe("resolve_for_run");
  });
});
