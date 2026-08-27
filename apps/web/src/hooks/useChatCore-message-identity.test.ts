import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { attachActiveTurnIdentity } from "./chat/activeTurnMessageIdentity";
import type { ConversationScope } from "./conversationScope";

const scope: ConversationScope = {
  sessionId: "d1137b54-39df-4f38-b012-478018630ace",
  runId: "run_123e4567e89b42d3a456426614174000",
  workspaceId: "wsp_identity01",
  threadId: "thr_identity01",
  turnId: "trn_identity01",
  runAttemptId: "attempt_identity01",
};

describe("attachActiveTurnIdentity", () => {
  it("adapts the live assistant frame into the canonical admitted turn", () => {
    const messages = [
      message("user-1", "user", "Inspect the repo"),
      message("assistant-1", "assistant", "Done"),
    ];

    const result = attachActiveTurnIdentity(messages, scope);

    expect(result[1]).toMatchObject({
      id: "assistant-1",
      data: {
        metadata: {
          canonicalIdentity: {
            workspaceId: scope.workspaceId,
            threadId: scope.threadId,
            turnId: scope.turnId,
            runAttemptId: scope.runAttemptId,
          },
          phase: "final_answer",
        },
      },
    });
    expect(messages[1]?.data).toBeUndefined();
  });

  it("preserves transcript-owned canonical identity", () => {
    const canonical = {
      ...message("assistant-1", "assistant", "Done"),
      data: {
        metadata: {
          canonicalIdentity: { ...scope, turnId: "trn_persisted01" },
        },
      },
    } as Message;

    expect(attachActiveTurnIdentity([canonical], scope)[0]).toBe(canonical);
  });
});

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
): Message {
  return { id, role, content } as Message;
}
