import { describe, expect, it } from "vitest";
import { formatDiagnosticLogLine } from "./diagnostic-log";

describe("diagnostic log formatter", () => {
  it("formats nested context as readable key-value fields", () => {
    const line = formatDiagnosticLogLine("run/post-execution", "projected", {
      runId: "run_123",
      event: { type: "run.completed", count: 2 },
      reason: "scope changed while request was in flight",
    });

    expect(line).toContain("[run/post-execution/projected]");
    expect(line).toContain("runId=run_123");
    expect(line).toContain("event.type=run.completed");
    expect(line).toContain("event.count=2");
    expect(line).toContain(
      'reason="scope changed while request was in flight"',
    );
    expect(line).not.toContain("[object Object]");
  });

  it("keeps unknown errors readable", () => {
    const line = formatDiagnosticLogLine("chat/persistence", "failed", {
      error: new Error("boom"),
    });

    expect(line).toContain("error.name=Error");
    expect(line).toContain("error.message=boom");
  });
});
