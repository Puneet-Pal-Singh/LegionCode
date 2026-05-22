import { describe, expect, it, vi } from "vitest";
import type { MemoryCoordinator } from "../memory/index.js";
import type { RunEventRecorder } from "../events/index.js";
import { Run } from "../run/index.js";
import {
  completeRunWithAssistantMessage,
  completeRunWithRecoveredAssistantMessage,
  type RunCompletionDependencies,
} from "./RunCompletionPolicy.js";

describe("RunCompletionPolicy", () => {
  it("does not overwrite a run cancelled while assistant completion was in flight", async () => {
    const run = createRun("RUNNING");
    const cancelledRun = createRun("CANCELLED");
    const deps = createDeps(cancelledRun);

    const response = await completeRunWithAssistantMessage({
      run,
      text: "late answer",
      deps,
    });

    await expect(response.text()).resolves.toBe("");
    expect(deps.runRepo.updateUnlessStatus).not.toHaveBeenCalled();
    expect(deps.runEventRecorder.recordMessageEmitted).not.toHaveBeenCalled();
    expect(run.status).toBe("RUNNING");
  });

  it("does not overwrite a cancelled run with recovered completion", async () => {
    const run = createRun("RUNNING");
    const cancelledRun = createRun("CANCELLED");
    const deps = createDeps(cancelledRun);

    const response = await completeRunWithRecoveredAssistantMessage({
      run,
      text: "late timeout recovery",
      deps,
    });

    await expect(response.text()).resolves.toBe("");
    expect(deps.runRepo.updateUnlessStatus).not.toHaveBeenCalled();
    expect(deps.runEventRecorder.recordRunCompleted).not.toHaveBeenCalled();
    expect(run.status).toBe("RUNNING");
  });

  it("does not emit completion events when the atomic completion update loses a cancellation race", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run, false);

    const response = await completeRunWithAssistantMessage({
      run,
      text: "late answer",
      deps,
    });

    await expect(response.text()).resolves.toBe("");
    expect(deps.runRepo.updateUnlessStatus).toHaveBeenCalledWith(run, [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]);
    expect(deps.runEventRecorder.recordMessageEmitted).not.toHaveBeenCalled();
    expect(deps.runEventRecorder.recordRunCompleted).not.toHaveBeenCalled();
  });
});

function createRun(status: "RUNNING" | "CANCELLED"): Run {
  return new Run("run-1", "session-1", status, "coding", {
    agentType: "coding",
    prompt: "hello",
    sessionId: "session-1",
  });
}

function createDeps(
  currentRun: Run,
  updateResult = true,
): RunCompletionDependencies {
  const runEventRecorder = {
    recordRunStatusChanged: vi.fn(),
    recordMessageEmitted: vi.fn(),
    recordRunCompleted: vi.fn(),
  } as unknown as RunEventRecorder;

  return {
    memoryCoordinator: {} as unknown as MemoryCoordinator,
    persistConversationMessages: vi.fn(),
    runEventRecorder,
    runRepo: {
      getById: vi.fn(async () => currentRun),
      updateUnlessStatus: vi.fn(async () => updateResult),
    },
    safeMemoryOperation: vi.fn(async (operation) => operation()),
  };
}
