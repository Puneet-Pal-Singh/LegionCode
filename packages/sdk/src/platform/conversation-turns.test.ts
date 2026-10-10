import { describe, expect, it } from "vitest";
import {
  buildConversationTurns,
  type ConversationMessage,
} from "./conversation-turns.js";

describe("conversation turns", () => {
  it("builds conversation turns from actual message identities", () => {
    const turns = buildConversationTurns([
      {
        id: "user-1",
        role: "user",
        content: "hey",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Hello! How can I help you today?",
      },
      {
        id: "user-2",
        role: "user",
        content: "hey",
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "I read the README and summarized it.",
      },
    ] satisfies ConversationMessage[]);

    expect(turns).toHaveLength(4);
    expect(turns[0]?.key).toBe("user-1");
    expect(turns[0]?.userMessage?.id).toBe("user-1");
    expect(turns[1]?.assistantMessages?.[0]?.id).toBe("assistant-1");
    expect(turns[2]?.key).toBe("user-2");
    expect(turns[2]?.userMessage?.id).toBe("user-2");
    expect(turns[3]?.assistantMessages?.[0]?.id).toBe("assistant-2");
  });

  it("does not infer a user turn from an assistant canonical identity", () => {
    const turns = buildConversationTurns([
      {
        id: "client-user",
        role: "user",
        content: "Read README",
      },
      {
        id: "server-assistant",
        role: "assistant",
        content: "Done",
        data: {
          metadata: {
            canonicalIdentity: {
              turnId: "trn_liveturn01",
            },
          },
        },
      },
    ] as ConversationMessage[]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.turnId).not.toBe("trn_liveturn01");
    expect(turns[1]?.turnId).toBe("trn_liveturn01");
  });

  it("preserves unidentified assistant rows instead of guessing their user turn", () => {
    const turns = buildConversationTurns([
      {
        id: "user-1",
        role: "user",
        content: "update the workflow ui",
      },
      {
        id: "assistant-progress-1",
        role: "assistant",
        content: "I'm checking the current renderer first.",
      },
      {
        id: "assistant-progress-2",
        role: "assistant",
        content: "I've narrowed it down to the workflow lane.",
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: "I updated the workflow UI to match the new compact design.",
      },
    ] satisfies ConversationMessage[]);

    expect(turns).toHaveLength(4);
    expect(turns[0]?.userMessage?.id).toBe("user-1");
    expect(
      turns.slice(1).map((turn) => turn.assistantMessages?.[0]?.id),
    ).toEqual([
      "assistant-progress-1",
      "assistant-progress-2",
      "assistant-final",
    ]);
  });

  it("projects replayed message ids once and keeps their latest payload", () => {
    const turns = buildConversationTurns([
      {
        id: "client_msg_same",
        role: "user",
        content: "hello",
      },
      {
        id: "assistant-same",
        role: "assistant",
        content: "partial",
      },
      {
        id: "client_msg_same",
        role: "user",
        content: "hello",
      },
      {
        id: "assistant-same",
        role: "assistant",
        content: "Hello! How can I help?",
      },
    ] satisfies ConversationMessage[]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.userMessage?.id).toBe("client_msg_same");
    expect(turns[1]?.assistantMessages?.[0]).toMatchObject({
      id: "assistant-same",
      content: "Hello! How can I help?",
    });
  });

  it("groups exact canonical assistant identities and preserves commentary rows", () => {
    const canonicalIdentity = {
      workspaceId: "wsp_metadata01",
      threadId: "thr_metadata01",
      turnId: "trn_metadata01",
      runAttemptId: "attempt_metadata01",
    };
    const turns = buildConversationTurns([
      {
        id: "user-1",
        role: "user",
        content: "Read README.md",
        data: { metadata: { canonicalIdentity } },
      },
      {
        id: "commentary-1",
        role: "assistant",
        content: "I’m reading the file.",
        data: { metadata: { canonicalIdentity, phase: "commentary" } },
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "The README is clear.",
        data: { metadata: { canonicalIdentity, phase: "final_answer" } },
      },
    ] as ConversationMessage[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: "trn_metadata01",
      userMessage: { id: "user-1" },
      assistantMessages: [{ id: "commentary-1" }, { id: "assistant-1" }],
    });
  });
});
