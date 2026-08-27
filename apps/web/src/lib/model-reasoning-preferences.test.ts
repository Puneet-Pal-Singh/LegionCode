import { beforeEach, describe, expect, it } from "vitest";
import {
  loadReasoningEffortSelection,
  resolveReasoningEffortForRequest,
  saveReasoningEffortSelection,
} from "./model-reasoning-preferences";

describe("model reasoning preferences", () => {
  beforeEach(() => localStorage.clear());

  it("clears a persisted effort removed from provider capabilities", () => {
    saveReasoningEffortSelection("openai", "gpt-test", "high");

    expect(
      resolveReasoningEffortForRequest("openai", "gpt-test", ["low"]),
    ).toBeUndefined();
    expect(loadReasoningEffortSelection("openai", "gpt-test")).toBe(
      "default",
    );
  });

  it("preserves a persisted effort still advertised by the provider", () => {
    saveReasoningEffortSelection("openai", "gpt-test", "high");

    expect(
      resolveReasoningEffortForRequest("openai", "gpt-test", ["high"]),
    ).toBe("high");
  });
});
