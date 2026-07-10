import { describe, expect, it } from "vitest";
import { deriveWorkspaceRunUiState } from "./runUiState";

describe("deriveWorkspaceRunUiState", () => {
  it("keeps an approval-waiting run stoppable", () => {
    const state = deriveWorkspaceRunUiState({
      canonicalRunStatus: "PAUSED",
      hasPendingApproval: true,
      isChatLoading: false,
      isSessionRunning: true,
      isLocallyStoppedRun: false,
      lastMessage: undefined,
    });

    expect(state.kind).toBe("approval_waiting");
    expect(state.isRunLoading).toBe(false);
    expect(state.canStopRun).toBe(true);
  });

  it("settles paused runs without pending approval", () => {
    const state = deriveWorkspaceRunUiState({
      canonicalRunStatus: "PAUSED",
      hasPendingApproval: false,
      isChatLoading: false,
      isSessionRunning: true,
      isLocallyStoppedRun: false,
      lastMessage: undefined,
    });

    expect(state.kind).toBe("terminal");
    expect(state.isRunLoading).toBe(false);
    expect(state.canStopRun).toBe(false);
  });

  it("treats canonical running state as active without local completion", () => {
    const state = deriveWorkspaceRunUiState({
      canonicalRunStatus: "RUNNING",
      hasPendingApproval: false,
      isChatLoading: false,
      isSessionRunning: false,
      isLocallyStoppedRun: false,
      lastMessage: undefined,
    });

    expect(state.kind).toBe("active");
    expect(state.isEffectiveCanonicalRunActive).toBe(true);
    expect(state.isRunLoading).toBe(true);
    expect(state.canStopRun).toBe(true);
  });

  it("uses local assistant output to finish stale canonical running state", () => {
    const state = deriveWorkspaceRunUiState({
      canonicalRunStatus: "RUNNING",
      hasPendingApproval: false,
      isChatLoading: false,
      isSessionRunning: true,
      isLocallyStoppedRun: false,
      lastMessage: {
        role: "assistant",
        content: "Done.",
      },
    });

    expect(state.kind).toBe("stale_completed");
    expect(state.hasLocalAssistantCompletion).toBe(true);
    expect(state.isRunLoading).toBe(false);
    expect(state.canStopRun).toBe(false);
  });

  it("lets explicit chat loading override terminal summaries", () => {
    const state = deriveWorkspaceRunUiState({
      canonicalRunStatus: "COMPLETED",
      hasPendingApproval: false,
      isChatLoading: true,
      isSessionRunning: false,
      isLocallyStoppedRun: false,
      lastMessage: undefined,
    });

    expect(state.kind).toBe("active");
    expect(state.isCanonicalRunTerminal).toBe(true);
    expect(state.isRunLoading).toBe(true);
  });
});
