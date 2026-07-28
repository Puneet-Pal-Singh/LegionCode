import { describe, expect, it, vi } from "vitest";
import {
  bootstrapConversationScope,
  conversationScopeKey,
  createConversationScope,
  isEstablishedRunScope,
  isTurnScopeRecoveryError,
  resumeConversationScope,
} from "./conversationScope";

describe("ConversationScope", () => {
  it("keeps workspace, thread, turn, and run identity in the scope key", () => {
    const base = createConversationScope({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      threadId: "thr_test-a",
      turnId: "trn_test-a",
      runAttemptId: "attempt_test-a",
      sessionId: "session-a",
      runId: "run-a",
    });

    expect(conversationScopeKey(base)).not.toBe(
      conversationScopeKey({
        ...base,
        workspaceId:
          "123e4567-e89b-42d3-a456-426614174001" as typeof base.workspaceId,
      }),
    );
    expect(conversationScopeKey(base)).not.toBe(
      conversationScopeKey({
        ...base,
        turnId: "trn_test-b" as typeof base.turnId,
      }),
    );
  });

  it("bootstraps the complete server-owned scope before chat use", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaceId: "123e4567-e89b-42d3-a456-426614174000",
          threadId: "thr_server001",
          turnId: "trn_server001",
          runAttemptId: "attempt_server001",
        }),
        { status: 201 },
      ),
    );

    const scope = await bootstrapConversationScope(
      "session-1",
      "run-1",
      "client-message-1",
    );

    expect(scope).toMatchObject({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      threadId: "thr_server001",
      turnId: "trn_server001",
      runAttemptId: "attempt_server001",
      sessionId: "session-1",
      runId: "run-1",
    });
    expect(conversationScopeKey(scope)).not.toContain("run-1");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/turn/start"),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          sessionId: "session-1",
          runId: "run-1",
          clientMessageId: "client-message-1",
        }),
      }),
    );
    fetchSpy.mockRestore();
  });

  it("does not request scope until both transport ids are hydrated", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(resumeConversationScope("", "run-1")).resolves.toBeNull();
    await expect(resumeConversationScope("session-1", " ")).resolves.toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not request scope for a legacy or placeholder run id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      resumeConversationScope("session-1", "pending-run"),
    ).resolves.toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("classifies only turn-scope recovery failures for targeted clearing", () => {
    expect(
      isTurnScopeRecoveryError(
        "Turn scope reconstruction failed with HTTP 400",
      ),
    ).toBe(true);
    expect(isTurnScopeRecoveryError("TURN_SCOPE_NOT_FOUND")).toBe(true);
    expect(isTurnScopeRecoveryError("Provider request failed")).toBe(false);
    expect(isTurnScopeRecoveryError(null)).toBe(false);
  });

  it("recognizes when a newer server-issued scope supersedes recovery", () => {
    const scope = createConversationScope({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      threadId: "thr_server001",
      turnId: "trn_server001",
      runAttemptId: "attempt_server001",
      sessionId: "session-1",
      runId: "run-1",
    });

    expect(isEstablishedRunScope(scope, "session-1", "run-1")).toBe(true);
    expect(isEstablishedRunScope(scope, "session-2", "run-1")).toBe(false);
    expect(isEstablishedRunScope(null, "session-1", "run-1")).toBe(false);
  });
});
