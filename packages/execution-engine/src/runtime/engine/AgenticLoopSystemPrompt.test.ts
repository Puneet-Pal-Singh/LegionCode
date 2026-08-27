import { describe, expect, it } from "vitest";
import { buildAgenticLoopSystemPrompt } from "./AgenticLoopSystemPrompt.js";

describe("buildAgenticLoopSystemPrompt", () => {
  it("requires a user-facing answer without internal deliberation", () => {
    const prompt = buildAgenticLoopSystemPrompt({
      finalSynthesisOnly: false,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      explicitCiLogRequest: false,
      encounteredCiLogsAuthorizationBoundary: false,
      attemptedCiLogsCliFallback: false,
    });

    expect(prompt).toContain("Return only the user-facing response.");
    expect(prompt).toContain("Never reveal chain-of-thought");
    expect(prompt).toContain(
      "Before each meaningful tool batch, emit one concise user-facing progress sentence",
    );
    expect(prompt).toContain("private rationale, hidden chain-of-thought");
    expect(prompt).toContain(
      'phrases such as "The user is asking" or "I should"',
    );
    expect(prompt).not.toContain("expectedSha256");
  });
});
