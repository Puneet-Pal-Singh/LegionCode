import { describe, expect, it } from "vitest";
import type { Message } from "@ai-sdk/react";
import { buildConversationTurns } from "./messageMetadata.js";

describe("messageMetadata", () => {
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
    ] satisfies Message[]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.key).toBe("user-1");
    expect(turns[0]?.userMessage?.id).toBe("user-1");
    expect(turns[0]?.assistantMessage?.id).toBe("assistant-1");
    expect(turns[1]?.key).toBe("user-2");
    expect(turns[1]?.userMessage?.id).toBe("user-2");
    expect(turns[1]?.assistantMessage?.id).toBe("assistant-2");
  });

  it("keeps the latest assistant message for a user turn when progress chatter streams first", () => {
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
    ] satisfies Message[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.userMessage?.id).toBe("user-1");
    expect(turns[0]?.assistantMessage?.id).toBe("assistant-final");
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
    ] satisfies Message[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.userMessage?.id).toBe("client_msg_same");
    expect(turns[0]?.assistantMessage).toMatchObject({
      id: "assistant-same",
      content: "Hello! How can I help?",
    });
  });
});
