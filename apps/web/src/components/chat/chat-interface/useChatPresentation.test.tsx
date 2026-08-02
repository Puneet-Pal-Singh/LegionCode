import { renderHook } from "@testing-library/react";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { useChatPresentation } from "./useChatPresentation";

describe("useChatPresentation", () => {
  it("keeps a canonical failed terminal visible instead of replacing it with a final-output placeholder", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [
          { id: "user-1", role: "user", content: "Read the project" },
        ],
        conversationTurns: [],
        hasHydrated: true,
        isLoading: false,
        hasPendingApproval: false,
        hasStartedSession: true,
        lifecycleProjection: failedProjection(),
      }),
    );

    expect(result.current.terminalViewModel).toMatchObject({
      state: "failed_runtime",
      content: "The workspace scope could not be established.",
    });
  });
});

function failedProjection(): LifecycleProjection {
  return {
    turnId: "trn_terminal_failure" as LifecycleProjection["turnId"],
    phase: "failed",
    lastSequence: 3,
    items: [],
    hookAudits: [],
    pendingApproval: null,
    terminal: {
      state: "failed",
      eventId: "evt_terminal_failure",
      content: "The workspace scope could not be established.",
      errorCode: "WORKSPACE_SCOPE_MISMATCH",
      occurredAt: "2026-07-18T10:00:00.000Z",
    },
    turnDiff: null,
    activeThinking: false,
    assistantText: "",
    startedAt: "2026-07-18T09:59:59.000Z",
    settledAt: "2026-07-18T10:00:00.000Z",
    contextBudget: null,
    usage: null,
  };
}
