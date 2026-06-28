import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleToolboxEventPublisher } from "../events/ToolboxEventPublisher";

describe("ConsoleToolboxEventPublisher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints toolbox events as readable key-value fields", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    new ConsoleToolboxEventPublisher().publish({
      sessionId: "session:with spaces",
      runId: "run_123",
      toolName: "filesystem.read_file",
      callId: "call_456",
      status: "completed",
      timestamp: 1234,
    });

    expect(logSpy).toHaveBeenCalledWith(
      '[toolbox/event] sessionId="session:with spaces" runId=run_123 toolName=filesystem.read_file callId=call_456 status=completed timestamp=1234',
    );
  });
});
