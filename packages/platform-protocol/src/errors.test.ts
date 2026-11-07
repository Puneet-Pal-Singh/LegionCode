import { describe, expect, it } from "vitest";
import { ProtocolErrorSchema, toPublicProtocolError } from "./errors.js";

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

    const publicError = toPublicProtocolError({
      ...error,
      message: "Bearer CANARY_PROVIDER_CREDENTIAL at /home/CANARY/.codex/auth.json",
      correlationId: "CANARY_UPSTREAM_CORRELATION",
      details: { providerStatusCode: 503, authorization: "CANARY_PROVIDER_CREDENTIAL" },
    }, undefined, "00000000-0000-4000-8000-000000000001");
    expect(publicError).toEqual({
      code: "worker_unavailable",
      message: "The execution environment is unavailable.",
      retryable: true,
      correlationId: "00000000-0000-4000-8000-000000000001",
      details: { providerStatusCode: 503 },
    });
    expect(JSON.stringify(publicError)).not.toContain("CANARY");
    expect(ProtocolErrorSchema.parse(publicError)).toEqual(publicError);
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
    expect(toPublicProtocolError({ code: "CANARY_CODE", message: "CANARY_BODY" })).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
      retryable: false,
      correlationId: null,
      details: null,
    });
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
    expect(toPublicProtocolError({
      code: "command_failed",
      get message() { throw new Error("Diagnostic text must not be inspected"); },
      details: { providerStatusCode: undefined, secret: "CANARY_SECRET" },
    })).toEqual({
      code: "command_failed",
      message: "The operation failed.",
      retryable: false,
      correlationId: null,
      details: null,
    });
  });
});
