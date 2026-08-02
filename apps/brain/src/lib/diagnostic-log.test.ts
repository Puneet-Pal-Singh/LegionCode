import { describe, expect, it } from "vitest";
import { formatDiagnosticLogLine } from "./diagnostic-log";

describe("diagnostic log formatter", () => {
  it("formats nested context as a structured JSON record", () => {
    const line = formatDiagnosticLogLine("run/post-execution", "projected", {
      runId: "run_123",
      event: { type: "run.completed", count: 2 },
      reason: "scope changed while request was in flight",
    });

    expect(JSON.parse(line)).toMatchObject({
      event: "run.post-execution.projected",
      service: "brain",
      attributes: {
        runId: "run_123",
        event: { type: "run.completed", count: 2 },
        reason: "scope changed while request was in flight",
      },
    });
  });

  it("keeps unknown errors readable", () => {
    const line = formatDiagnosticLogLine("chat/persistence", "failed", {
      error: new Error("boom"),
    });

    expect(JSON.parse(line)).toMatchObject({
      attributes: { error: { name: "Error", message: "boom" } },
    });
  });
});
