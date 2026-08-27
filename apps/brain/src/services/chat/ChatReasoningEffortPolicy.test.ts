import { describe, expect, it } from "vitest";
import { validateChatReasoningEffort } from "./ChatReasoningEffortPolicy";

describe("validateChatReasoningEffort", () => {
  it("accepts provider-declared efforts and omitted values", () => {
    const metadata = { reasoningEfforts: ["low", "high"] };
    expect(validateChatReasoningEffort(undefined, metadata)).toBeNull();
    expect(validateChatReasoningEffort("high", metadata)).toBeNull();
  });

  it("rejects an effort the selected model does not advertise", () => {
    expect(
      validateChatReasoningEffort("max", {
        reasoningEfforts: ["low", "high"],
      }),
    ).toMatch(/not supported/);
  });

  it("rejects defined efforts when provider metadata does not advertise any", () => {
    expect(validateChatReasoningEffort("high", {})).toMatch(/not supported/);
    expect(validateChatReasoningEffort("", {})).toMatch(/not supported/);
  });
});
