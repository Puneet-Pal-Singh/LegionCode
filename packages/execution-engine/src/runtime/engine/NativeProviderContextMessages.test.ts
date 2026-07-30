import { describe, expect, it } from "vitest";
import {
  buildProviderContextMessages,
  estimateConversationTokens,
  summarizeConversationForCompaction,
} from "./NativeProviderContextMessages.js";

describe("NativeProviderContextMessages", () => {
  const messages = [
    { role: "user" as const, content: "first request" },
    { role: "assistant" as const, content: "first answer" },
    { role: "user" as const, content: "latest request" },
  ];

  it("uses compacted context plus the latest request", () => {
    expect(
      buildProviderContextMessages({
        messages,
        compactedContext: "preserved summary",
      }),
    ).toEqual([
      {
        role: "system",
        content: "Compacted conversation context:\npreserved summary",
      },
      { role: "user", content: "latest request" },
    ]);
  });

  it("estimates the complete conversation and preserves it in a bounded summary", () => {
    expect(estimateConversationTokens(messages)).toBeGreaterThan(1);
    expect(
      summarizeConversationForCompaction(messages, "latest request"),
    ).toContain("assistant: first answer");
  });
});
