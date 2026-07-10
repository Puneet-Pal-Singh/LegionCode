import { describe, expect, it } from "vitest";
import {
  conversationScopeKey,
  createConversationScope,
} from "./conversationScope";

describe("ConversationScope", () => {
  it("keeps workspace, thread, turn, and run identity in the scope key", () => {
    const base = createConversationScope({
      workspaceId: "workspace-a",
      sessionId: "thread-a",
      turnId: "turn-a",
      runId: "run-reused",
    });

    expect(conversationScopeKey(base)).not.toBe(
      conversationScopeKey({ ...base, workspaceId: "workspace-b" }),
    );
    expect(conversationScopeKey(base)).not.toBe(
      conversationScopeKey({ ...base, turnId: "turn-b" }),
    );
  });
});
