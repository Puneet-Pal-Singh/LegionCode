import { describe, expect, it } from "vitest";
import { formatTraceparent, parseTraceparent } from "./trace-context.js";

describe("trace context", () => {
  it("round-trips a valid W3C traceparent", () => {
    const context = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: "01" as const,
    };
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });

  it("rejects malformed traceparent values", () => {
    expect(parseTraceparent("not-a-trace")).toBeNull();
  });
});
