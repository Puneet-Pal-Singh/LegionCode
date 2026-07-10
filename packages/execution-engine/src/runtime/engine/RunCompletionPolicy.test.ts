import { describe, expect, it, vi } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import type { MemoryCoordinator } from "../memory/index.js";
import type { RunEventRecorder } from "../events/index.js";
import { Run } from "../run/index.js";
import {
  completeRunWithAssistantMessage,
  completeRunWithRecoveredAssistantMessage,
  finalizeRunWithAssistantMessage,
  pauseRunForApprovalWithAssistantMessage,
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

  it("pauses approval-required runs instead of marking them completed", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    const response = await finalizeRunWithAssistantMessage({
      run,
      text: "I need your approval before I can continue.",
      metadata: { terminalState: RUN_TERMINAL_STATES.APPROVAL_REQUIRED },
      deps,
    });

    await expect(response.text()).resolves.toContain(
      "I need your approval before I can continue.",
    );
    expect(run.status).toBe("PAUSED");
    expect(deps.runEventRecorder.recordRunStatusChanged).toHaveBeenCalledWith(
      "RUNNING",
      "PAUSED",
      "synthesis",
    );
    expect(deps.runEventRecorder.recordRunCompleted).not.toHaveBeenCalled();
    expect(run.metadata.terminalState).toBe(
      RUN_TERMINAL_STATES.APPROVAL_REQUIRED,
    );
  });

  it("pauses approval runs through the explicit approval finalizer", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    const response = await pauseRunForApprovalWithAssistantMessage({
      run,
      text: "Approval is required.",
      deps,
    });

    await expect(response.text()).resolves.toContain("Approval is required.");
    expect(run.status).toBe("PAUSED");
    expect(deps.runRepo.updateUnlessStatus).toHaveBeenCalledWith(run, [
      "PAUSED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]);
  });

  it("fails fast when approval metadata is sent to the completion finalizer", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    await expect(
      completeRunWithAssistantMessage({
        run,
        text: "Approval is required.",
        metadata: { terminalState: RUN_TERMINAL_STATES.APPROVAL_REQUIRED },
        deps,
      }),
    ).rejects.toThrow(
      "completeRunWithAssistantMessage cannot finalize approval-required runs",
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
      text: "",
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
      modelParts: [
        {
          id: "model-final-part",
          schemaVersion: 1,
          runId: run.id,
          turnId: run.id,
          sequence: 0,
          createdAt: "2026-07-10T00:00:00.000Z",
          type: "final",
          visibility: "visible",
          text: "Done. I changed the requested files.",
        },
      ],
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

  it("enriches final terminal metadata with changed files and step hints", async () => {
    const run = createRun("RUNNING");
    run.metadata.agenticLoop = {
      enabled: true,
      stopReason: "tool_error",
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "create_code_artifact",
          status: "completed",
          mutating: true,
          recordedAt: "2026-06-03T00:00:00.000Z",
          metadata: {
            family: "edit",
            filePath: "src/App.tsx",
            additions: 4,
            deletions: 1,
          },
        },
        {
          toolCallId: "tool-2",
          toolName: "npm_test",
          status: "failed",
          mutating: false,
          recordedAt: "2026-06-03T00:00:01.000Z",
        },
      ],
    };
    const deps = createDeps(run);

    await completeRunWithAssistantMessage({
      run,
      text: "Tests failed after the edit.",
      metadata: {
        terminalState: RUN_TERMINAL_STATES.FAILED_TOOL,
        resumeHint: "Fix the failing test and retry.",
      },
      deps,
    });

    expect(run.metadata.terminalMessage).toMatchObject({
      terminalState: RUN_TERMINAL_STATES.FAILED_TOOL,
      changedFileCount: 1,
      lastSuccessfulStep: "create_code_artifact",
      failedStep: "npm_test",
      nextAction: "Fix the failing test and retry.",
    });
    expect(deps.runEventRecorder.recordMessageEmitted).toHaveBeenCalledWith(
      "assistant",
      "Tests failed after the edit.",
      expect.objectContaining({
        changedFileCount: 1,
        failedStep: "npm_test",
      }),
    );
    expect(run.status).toBe("FAILED");
    expect(deps.runEventRecorder.recordRunFailed).toHaveBeenCalledWith(
      "Tests failed after the edit.",
      expect.any(Number),
    );
    expect(deps.memoryCoordinator.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ runStatus: "FAILED" }),
    );
  });

  it("fails file-review finalization without read or search evidence", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);

    const response = await completeRunWithAssistantMessage({
      run,
      text: "The file looks correct.",
      metadata: {
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
        requiredEvidence: ["file_read_or_search"],
      },
      deps,
    });

    await expect(response.text()).resolves.toContain(
      "did not record the required evidence",
    );
    expect(run.status).toBe("FAILED");
    expect(run.metadata.terminalState).toBe(
      RUN_TERMINAL_STATES.FAILED_VALIDATION,
    );
    expect(run.metadata.finalizationContract).toMatchObject({
      settled: false,
      missingEvidence: ["file_read_or_search"],
    });
    expect(deps.runEventRecorder.recordRunFailed).toHaveBeenCalledWith(
      expect.stringContaining("required evidence"),
      expect.any(Number),
    );
  });

  it("settles file-review finalization with read or search evidence", async () => {
    const run = createRun("RUNNING");
    run.metadata.agenticLoop = {
      enabled: true,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "completed",
          mutating: false,
          recordedAt: "2026-06-03T00:00:00.000Z",
          metadata: {
            family: "read",
            path: "src/App.tsx",
            count: 30,
            truncated: false,
            loadedPaths: ["src/App.tsx"],
          },
        },
      ],
    };
    const deps = createDeps(run);

    await completeRunWithAssistantMessage({
      run,
      text: "The file looks correct.",
      metadata: {
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
        requiredEvidence: ["file_read_or_search"],
      },
      deps,
    });

    expect(run.status).toBe("COMPLETED");
    expect(run.metadata.finalizationContract).toMatchObject({
      settled: true,
      missingEvidence: [],
    });
    expect(run.metadata.evidenceLedger).toEqual([
      expect.objectContaining({
        kind: "file_read",
        path: "src/App.tsx",
      }),
    ]);
  });

  it("fails edit finalization without edit or diff evidence", async () => {
    const run = createRun("RUNNING");
    run.metadata.agenticLoop = {
      enabled: true,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "completed",
          mutating: false,
          recordedAt: "2026-06-03T00:00:00.000Z",
          metadata: {
            family: "read",
            path: "src/App.tsx",
            count: 30,
            truncated: false,
            loadedPaths: ["src/App.tsx"],
          },
        },
      ],
    };
    const deps = createDeps(run);

    await completeRunWithAssistantMessage({
      run,
      text: "I changed the file.",
      metadata: {
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
        requiredEvidence: ["file_edit_or_diff"],
      },
      deps,
    });

    expect(run.status).toBe("FAILED");
    expect(run.metadata.terminalMessage).toMatchObject({
      code: "FINALIZATION_MISSING_EVIDENCE",
      finalizationContract: {
        settled: false,
        missingEvidence: ["file_edit_or_diff"],
      },
    });
  });

  it("settles edit finalization with edit or diff evidence", async () => {
    const run = createRun("RUNNING");
    run.metadata.agenticLoop = {
      enabled: true,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "git_diff",
          status: "completed",
          mutating: false,
          recordedAt: "2026-06-03T00:00:00.000Z",
          metadata: {
            family: "git",
            displayText: "Diff",
          },
        },
      ],
    };
    const deps = createDeps(run);

    await completeRunWithAssistantMessage({
      run,
      text: "I changed the file.",
      metadata: {
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
        requiredEvidence: ["file_edit_or_diff"],
      },
      deps,
    });

    expect(run.status).toBe("COMPLETED");
    expect(run.metadata.finalizationContract).toMatchObject({
      settled: true,
      missingEvidence: [],
    });
    expect(run.metadata.evidenceLedger).toEqual([
      expect.objectContaining({ kind: "git_diff" }),
    ]);
  });

  it("fails terminal settlement when final assistant transcript persistence fails", async () => {
    const run = createRun("RUNNING");
    const deps = createDeps(run);
    const failure = new Error("transcript unavailable");
    vi.mocked(deps.persistConversationMessages).mockRejectedValueOnce(failure);

    await expect(
      completeRunWithAssistantMessage({
        run,
        text: "Done.",
        deps,
      }),
    ).rejects.toThrow("transcript unavailable");
    expect(deps.safeMemoryOperation).toHaveBeenCalled();
    expect(deps.runEventRecorder.recordMessageEmitted).not.toHaveBeenCalled();
    expect(deps.runEventRecorder.recordRunCompleted).not.toHaveBeenCalled();
  });
});

function createRun(status: "RUNNING" | "CANCELLED"): Run {
  return new Run(
    "run_100001",
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
    recordRunFailed: vi.fn(),
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
    safeMemoryOperation: vi.fn(async (operation) => await operation()),
  };
}
