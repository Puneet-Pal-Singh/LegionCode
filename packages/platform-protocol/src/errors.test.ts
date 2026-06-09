import { describe, expect, it } from "vitest";
import { ProtocolErrorSchema } from "./errors.js";

describe("ProtocolErrorSchema", () => {
  it("parses a client-safe typed error envelope", () => {
    const error = ProtocolErrorSchema.parse({
      code: "worker_unavailable",
      message: "No worker is available for this run.",
      retryable: true,
      correlationId: "request-123",
      details: {
        region: "auto",
      },
    });

    expect(error.code).toBe("worker_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("rejects unregistered error codes", () => {
    expect(() =>
      ProtocolErrorSchema.parse({
        code: "provider_error",
        message: "Provider failed.",
        retryable: false,
        correlationId: null,
        details: null,
      }),
    ).toThrow();
  });

  it("rejects undeclared fields that could expose internal errors", () => {
    expect(() =>
      ProtocolErrorSchema.parse({
        code: "internal_error",
        message: "Request failed.",
        retryable: false,
        correlationId: null,
        details: null,
        stack: "sensitive stack",
      }),
    ).toThrow();
  });
});
