import { describe, expect, it } from "vitest";
import {
  createSecureRequestContext,
  withSecureObservabilityHeaders,
} from "./SecureRequestObservability";

describe("SecureRequestObservability", () => {
  it("preserves an inbound correlation and trace context", async () => {
    const traceparent =
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const context = createSecureRequestContext(
      new Request("https://secure.example/api/v1/execute", {
        headers: {
          "X-Correlation-Id": "corr-existing",
          traceparent,
        },
      }),
    );

    expect(context.correlationId).toBe("corr-existing");
    expect(context.request.headers.get("traceparent")).toBe(traceparent);

    const response = withSecureObservabilityHeaders(
      new Response("ok"),
      context.request,
    );
    expect(response.headers.get("X-Correlation-Id")).toBe("corr-existing");
    expect(response.headers.get("traceparent")).toBe(traceparent);
    expect(await response.text()).toBe("ok");
  });

  it("creates and returns correlation and trace context when absent", () => {
    const context = createSecureRequestContext(
      new Request("https://secure.example/api/v1/session"),
    );

    expect(context.correlationId).not.toBe("");
    expect(context.request.headers.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });
});
