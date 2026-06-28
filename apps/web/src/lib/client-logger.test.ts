import { describe, expect, it } from "vitest";
import { formatClientLogLine } from "./client-logger";

describe("client logger", () => {
  it("formats context as one readable JSON line", () => {
    const line = formatClientLogLine("run/events", "received", {
      runId: "run_123",
      event: { type: "run.progress", count: 2 },
    });

    expect(line).toContain("[run/events/received]");
    expect(line).toContain('"format":"json-v2"');
    expect(line).toMatch(/"clientInstanceId":"(server|tab_[^"]+)"/);
    expect(line).toContain('"runId":"run_123"');
    expect(line).toContain('"type":"run.progress"');
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

    expect(line).toContain('"count":"1"');
    expect(line).toContain('"self":"[Circular]"');
    expect(line).toContain('"name":"Error"');
    expect(line).toContain('"message":"boom"');
  });
});
