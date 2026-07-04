import { describe, expect, it } from "vitest";
import { shouldUseNativeConversationalTurn } from "./RunNativeConversationalTurnPolicy.js";

describe("RunNativeConversationalTurnPolicy", () => {
  it("routes ordinary chat through the no-tools native conversational path", () => {
    expect(
      shouldUseNativeConversationalTurn({
        agentType: "coding",
        prompt: "yoyyo boi how are you?",
        sessionId: "session-1",
      }),
    ).toBe(true);
  });

  it("keeps repository and file actions on the native tool path", () => {
    expect(
      shouldUseNativeConversationalTurn({
        agentType: "coding",
        prompt: "yo, help me make my hero page better @index.tsx",
        sessionId: "session-1",
      }),
    ).toBe(false);
    expect(
      shouldUseNativeConversationalTurn({
        agentType: "coding",
        prompt: "read README.md",
        sessionId: "session-1",
      }),
    ).toBe(false);
    expect(
      shouldUseNativeConversationalTurn({
        agentType: "coding",
        prompt:
          "Hey, read my readme and tell what do you think of this project??",
        sessionId: "session-1",
      }),
    ).toBe(false);
  });
});
