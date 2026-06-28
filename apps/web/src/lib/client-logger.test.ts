import { describe, expect, it } from "vitest";
import { formatClientLogLine } from "./client-logger";

describe("client logger", () => {
  it("formats context as one readable key-value line", () => {
    const line = formatClientLogLine("run/events", "received", {
      runId: "run_123",
      event: { type: "run.progress", count: 2 },
    });

    expect(line).toContain("[run/events/received]");
    expect(line).toContain("format=kv-v1");
    expect(line).toMatch(/clientInstanceId=(server|tab_[^ ]+)/);
    expect(line).toContain("runId=run_123");
    expect(line).toContain("event.type=run.progress");
    expect(line).toContain("event.count=2");
    expect(line).not.toContain("[object Object]");
    expect(line).not.toContain(" Object");
  });

  it("keeps difficult values readable without breaking the log line", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const line = formatClientLogLine("chat", "failed", {
      count: 1n as unknown as string,
      circular,
      error: new Error("boom") as unknown as string,
    });

    expect(line).toContain("count=1");
    expect(line).toContain('circular.self="[Circular]"');
    expect(line).toContain("error.name=Error");
    expect(line).toContain("error.message=boom");
  });

  it("quotes only values that need quoting", () => {
    const line = formatClientLogLine("chat/hydration", "discarded", {
      runId: "run_123",
      reason: "scope changed while request was in flight",
    });

    expect(line).toContain("runId=run_123");
    expect(line).toContain(
      'reason="scope changed while request was in flight"',
    );
  });
});
