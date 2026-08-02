import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleToolboxEventPublisher } from "../events/ToolboxEventPublisher";

describe("ConsoleToolboxEventPublisher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not print successful toolbox events unless verbose logging is enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    new ConsoleToolboxEventPublisher().publish({
      sessionId: "session:with spaces",
      runId: "run_123",
      toolName: "filesystem.read_file",
      callId: "call_456",
      status: "completed",
      timestamp: 1234,
    });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("prints failed toolbox events as readable key-value fields", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    new ConsoleToolboxEventPublisher().publish({
      sessionId: "session:with spaces",
      runId: "run_123",
      toolName: "filesystem.read_file",
      callId: "call_456",
      status: "failed",
      timestamp: 1234,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[toolbox/event] sessionId="session:with spaces" runId=run_123 toolName=filesystem.read_file callId=call_456 status=failed timestamp=1234',
    );
  });

  it("prints successful toolbox events when verbose logging is enabled", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("LEGIONCODE_VERBOSE_TOOLBOX_LOGS", "true");

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
