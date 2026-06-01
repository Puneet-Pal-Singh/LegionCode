import { describe, expect, it, vi } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
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

  it("can persist a recovered assistant message as a paused run", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    const response = await completeRunWithRecoveredAssistantMessage({
      run,
      text: "The selected model stopped responding, so I paused this run.",
      metadata: {
        code: "PROVIDER_UNAVAILABLE",
        terminalState: RUN_TERMINAL_STATES.INTERRUPTED,
      },
      terminalStatus: "PAUSED",
      deps,
    });

    await expect(response.text()).resolves.toContain("paused this run");
    expect(run.status).toBe("PAUSED");
    expect(deps.runRepo.updateUnlessStatus).toHaveBeenCalledWith(run, [
      "PAUSED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]);
    expect(deps.runEventRecorder.recordRunStatusChanged).toHaveBeenCalledWith(
      "RUNNING",
      "PAUSED",
      "synthesis",
    );
    expect(deps.runEventRecorder.recordRunCompleted).not.toHaveBeenCalled();
    expect(deps.memoryCoordinator.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ runStatus: "PAUSED" }),
    );
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

  it("emits deterministic runtime text when assistant completion text is empty", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    const response = await completeRunWithAssistantMessage({
      run,
      text: '{ "success": true, "output": "" }',
      metadata: { terminalState: RUN_TERMINAL_STATES.COMPLETED },
      deps,
    });

    await expect(response.text()).resolves.toContain(
      "I finished the run, but the model did not produce a final response.",
    );
    expect(run.output?.finalSummary).toContain(
      "I finished the run, but the model did not produce a final response.",
    );
    expect(deps.runEventRecorder.recordMessageEmitted).toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("I finished the run"),
      expect.objectContaining({
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
        finalMessageSource: "runtime",
      }),
    );
  });

  it("records terminal state metadata on model-authored final messages", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    await completeRunWithAssistantMessage({
      run,
      text: "Done. I changed the requested files.",
      metadata: { terminalState: RUN_TERMINAL_STATES.COMPLETED },
      deps,
    });

    expect(deps.runEventRecorder.recordMessageEmitted).toHaveBeenCalledWith(
      "assistant",
      "Done. I changed the requested files.",
      expect.objectContaining({
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
        finalMessageSource: "model",
      }),
    );
  });

  it("handles final assistant transcript persistence failure gracefully", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);
    const failure = new Error("transcript unavailable");
    vi.mocked(deps.persistConversationMessages).mockRejectedValueOnce(failure);

    const response = await completeRunWithAssistantMessage({
      run,
      text: "Done.",
      deps,
    });

    await expect(response.text()).resolves.toBe("Done.");
    expect(deps.safeMemoryOperation).toHaveBeenCalled();
    expect(deps.runEventRecorder.recordMessageEmitted).toHaveBeenCalled();
    expect(deps.runEventRecorder.recordRunCompleted).toHaveBeenCalled();
  });
});

function createRun(status: "RUNNING" | "CANCELLED"): Run {
  return new Run(
    "run-1",
    "session-1",
    status,
    "coding",
    {
      agentType: "coding",
      prompt: "hello",
      sessionId: "session-1",
    },
    undefined,
    {
      prompt: "hello",
      manifest: {
        mode: "build",
        providerId: "openai",
        modelId: "gpt-4o",
        harness: "cloudflare-sandbox",
        orchestratorBackend: "execution-engine-v1",
        executionBackend: "cloudflare_sandbox",
        harnessMode: "platform_owned",
        authMode: "api_key",
      },
    },
  );
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
  const memoryCoordinator = {
    extractAndPersist: vi.fn(),
    createCheckpoint: vi.fn(),
  } as unknown as MemoryCoordinator;

  return {
    memoryCoordinator,
    persistConversationMessages: vi.fn(),
    runEventRecorder,
    runRepo: {
      getById: vi.fn(async () => currentRun),
      updateUnlessStatus: vi.fn(async () => updateResult),
    },
    safeMemoryOperation: vi.fn(async (operation) => {
      try {
        return await operation();
      } catch {
        return undefined;
      }
    }),
  };
}
