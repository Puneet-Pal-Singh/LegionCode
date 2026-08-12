import { renderHook } from "@testing-library/react";
import { createInitialPromptSubmissionId } from "../../../lib/initial-prompt-submission";
import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { useChatPresentation } from "./useChatPresentation";

describe("useChatPresentation", () => {
  it("keeps the loading placeholder visible while a new task identity hydrates", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [
          {
            id: "stale-message",
            role: "assistant",
            content: "Previous task content",
          },
        ],
        conversationTurns: [],
        hasHydrated: false,
        isLoading: false,
        hasPendingApproval: false,
        hasStartedSession: true,
      }),
    );

    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.showSessionPlaceholder).toBe(true);
  });

  it("does not reveal a pending approval before the selected task hydrates", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [],
        conversationTurns: [],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: true,
        hasStartedSession: true,
      }),
    );

    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.showSessionPlaceholder).toBe(true);
  });

  it("reveals an optimistically admitted prompt while canonical replay hydrates", () => {
    const userMessage = {
      id: "client_msg_pending",
      role: "user" as const,
      content: "Explain the failing test",
    };
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [userMessage],
        conversationTurns: [
          {
            key: "turn:client_msg_pending",
            userMessage,
            assistantMessage: undefined,
            turnId: undefined,
          },
        ],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        hasImmediateUserSubmission: true,
      }),
    );

    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.showSessionPlaceholder).toBe(false);
    expect(result.current.chatEntries[0]).toMatchObject({
      kind: "message",
      message: {
        id: "client_msg_pending",
        role: "user",
        content: "Explain the failing test",
      },
    });
  });

  it("renders the submitted setup prompt instead of a centered session spinner", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [],
        conversationTurns: [],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        initialPromptSubmission: {
          id: createInitialPromptSubmissionId("setup-1"),
          prompt: "Inspect the README",
        },
      }),
    );

    expect(result.current.showSessionPlaceholder).toBe(false);
    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.chatEntries[0]).toMatchObject({
      kind: "message",
      message: { role: "user", content: "Inspect the README" },
    });
  });

  it("does not duplicate the setup prompt after the canonical chat projects it", () => {
    const userMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Inspect the README",
    };
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [userMessage],
        conversationTurns: [
          {
            key: "turn:user-1",
            userMessage,
            assistantMessage: undefined,
            turnId: undefined,
          },
        ],
        hasHydrated: true,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        initialPromptSubmission: {
          id: createInitialPromptSubmissionId("setup-1"),
          prompt: "Inspect the README",
        },
      }),
    );

    expect(
      result.current.chatEntries.filter((entry) => entry.kind === "message"),
    ).toHaveLength(1);
  });

  it("keeps a canonical failed terminal visible instead of replacing it with a final-output placeholder", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [{ id: "user-1", role: "user", content: "Read the project" }],
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
