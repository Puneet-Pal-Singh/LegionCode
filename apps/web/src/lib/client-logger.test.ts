import { describe, expect, it } from "vitest";
import { formatClientLogLine } from "./client-logger";

describe("client logger", () => {
  it("formats context as one readable JSON line", () => {
    const line = formatClientLogLine("run/events", "received", {
      runId: "run_123",
      event: { type: "run.progress", count: 2 },
    });

    expect(line).toContain("[run/events/received]");
    expect(line).toContain('"runId":"run_123"');
    expect(line).toContain('"type":"run.progress"');
    expect(line).not.toContain("[object Object]");
    expect(line).not.toContain(" Object");
  });
});
