import { describe, expect, it, vi } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { Run } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import type { RunRepository } from "../run/index.js";
import {
  handleExecutionErrorPolicy,
  safeMemoryOperation,
} from "./RunEngineReliabilityPolicy.js";

describe("RunEngineReliabilityPolicy", () => {
  it("persists and emits a sanitized final summary for failed runs", async () => {
    const run = new Run("run_100000", "session-1", "RUNNING", "coding", {
      agentType: "coding",
      prompt: "run tests",
      sessionId: "session-1",
    });

    const runRepo = {
      getById: vi.fn(async () => run),
      update: vi.fn(async () => undefined),
    } as unknown as RunRepository;

    const runEventRecorder = {
      recordMessageEmitted: vi.fn(async () => undefined),
      recordRunFailed: vi.fn(async () => undefined),
    } as unknown as RunEventRecorder;

    await handleExecutionErrorPolicy({
      runId: "run_100000",
      error: new Error("runtime exploded at https://internal/errors/123"),
      runRepo,
      runEventRecorder,
      getRunDurationMs: () => 25,
    });

    expect(run.status).toBe("FAILED");
    expect(run.metadata.terminalState).toBe(RUN_TERMINAL_STATES.FAILED_RUNTIME);
    expect(run.output?.content).toContain("[internal-url]");
    expect(run.output?.finalSummary).toContain("[internal-url]");
    expect(run.output?.content).toBe(run.output?.finalSummary);
    expect(runEventRecorder.recordMessageEmitted).toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("[internal-url]"),
      { terminalState: RUN_TERMINAL_STATES.FAILED_RUNTIME },
    );
    expect(runEventRecorder.recordRunFailed).toHaveBeenCalledWith(
      "runtime exploded at https://internal/errors/123",
      25,
    );
  });

  it("fails fast when memory persistence fails", async () => {
    const failure = new Error("checkpoint rejected");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(safeMemoryOperation(async () => {
      throw failure;
    })).rejects.toThrow("checkpoint rejected");

    expect(consoleError).toHaveBeenCalledWith(
      "[run/engine] Memory subsystem operation failed:",
      failure,
    );
    consoleError.mockRestore();
  });
});
