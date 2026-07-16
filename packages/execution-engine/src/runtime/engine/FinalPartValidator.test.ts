import { describe, expect, it } from "vitest";
import {
  isExplicitFinalTranscriptPart,
  projectExplicitFinalText,
} from "./FinalPartValidator.js";

const base = {
  schemaVersion: 1 as const,
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-07-10T00:00:00.000Z",
};

describe("FinalPartValidator", () => {
  it("accepts only non-empty typed final parts", () => {
    const finalPart = {
      ...base,
      id: "final",
      sequence: 2,
      type: "final" as const,
      visibility: "visible" as const,
      text: "Done.",
    };
    const visiblePart = {
      ...base,
      id: "visible",
      sequence: 0,
      type: "visible_text" as const,
      visibility: "visible" as const,
      text: "The user is asking what I should respond",
      finalized: false,
    };
    const reasoningPart = {
      ...base,
      id: "reasoning",
      sequence: 1,
      type: "reasoning" as const,
      visibility: "audit_only" as const,
      text: "private plan",
    };

    expect(isExplicitFinalTranscriptPart(finalPart)).toBe(true);
    expect(isExplicitFinalTranscriptPart(visiblePart)).toBe(false);
    expect(isExplicitFinalTranscriptPart(reasoningPart)).toBe(false);
    expect(
      projectExplicitFinalText([visiblePart, reasoningPart, finalPart]),
    ).toBe("Done.");
  });

  it("does not classify blank final parts as terminal output", () => {
    const blankPart = {
      ...base,
      id: "blank-final",
      sequence: 0,
      type: "final" as const,
      visibility: "visible" as const,
      text: "  ",
    };

    expect(isExplicitFinalTranscriptPart(blankPart)).toBe(false);
    expect(projectExplicitFinalText([blankPart])).toBe("");
  });
});
