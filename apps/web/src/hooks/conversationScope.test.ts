import { describe, expect, it, vi } from "vitest";
import {
  bootstrapConversationScope,
  conversationScopeKey,
  createConversationScope,
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
        workspaceId: "123e4567-e89b-42d3-a456-426614174001" as typeof base.workspaceId,
      }),
    );
    expect(conversationScopeKey(base)).not.toBe(
      conversationScopeKey({ ...base, turnId: "trn_test-b" as typeof base.turnId }),
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

    const scope = await bootstrapConversationScope("session-1", "run-1");

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
        body: JSON.stringify({ sessionId: "session-1", runId: "run-1" }),
      }),
    );
    fetchSpy.mockRestore();
  });
});
