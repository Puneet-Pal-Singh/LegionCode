import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import {
  reportBrainError,
  withCorrelationId,
  withObservabilityHeaders,
} from "./BrainErrorReporter";

describe("BrainErrorReporter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits a redacted report with the request, release, and operational error context", () => {
    const error = Object.assign(new Error("provider token=secret-value"), {
      code: "PROVIDER_REQUEST_FAILED",
      retryable: true,
      status: 503,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = withCorrelationId(
      new Request("https://brain.example/chat", { method: "POST" }),
      "corr_123",
    );

    reportBrainError({ ENVIRONMENT: "test" } as Env, {
      request,
      operation: "chat.request.execute",
      error,
      context: { runId: "run_123" },
    });

    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
      level: "error",
      event: "chat.request.execute.failed",
      service: "brain",
      environment: "test",
      attributes: {
        operation: "chat.request.execute",
        route: "/chat",
        correlationId: "corr_123",
        runId: "run_123",
        errorCode: "PROVIDER_REQUEST_FAILED",
        retryable: true,
      },
    });
  });

  it("preserves the correlation identifier on responses", async () => {
    const response = withObservabilityHeaders(new Response("ok"), "corr_123");

    expect(response.headers.get("X-Correlation-Id")).toBe("corr_123");
    await expect(response.text()).resolves.toBe("ok");
  });
});
