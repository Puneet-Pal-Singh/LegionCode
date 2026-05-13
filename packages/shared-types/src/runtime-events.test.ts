import { describe, expect, it } from "vitest";
import {
  InternalRuntimeEventRequestSchema,
  buildRuntimeEventSignatureBase,
  formatRuntimeEventSignature,
} from "./runtime-events.js";

describe("runtime event contract", () => {
  it("accepts the PR1 internal runtime event envelope", () => {
    const result = InternalRuntimeEventRequestSchema.safeParse({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1", status: "completed" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown fields so signed bodies stay canonical", () => {
    const result = InternalRuntimeEventRequestSchema.safeParse({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: {},
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });

  it("formats the signature base consistently", () => {
    expect(buildRuntimeEventSignatureBase("123", '{"ok":true}')).toBe(
      '123.{"ok":true}',
    );
    expect(formatRuntimeEventSignature("abc123")).toBe("v1=abc123");
  });
});
