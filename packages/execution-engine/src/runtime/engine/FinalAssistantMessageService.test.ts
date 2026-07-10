import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { FinalAssistantMessageService } from "./FinalAssistantMessageService.js";

const completed = {
  terminalState: RUN_TERMINAL_STATES.COMPLETED,
  outcomeCode: "COMPLETED" as const,
};

describe("FinalAssistantMessageService", () => {
  it("projects exactly one typed final part from visible typed parts", () => {
    const result = new FinalAssistantMessageService().build({
      ...completed,
      finalParts: [
        { type: "visible_text", text: "Done." },
        { type: "final", text: "The edit is complete." },
      ],
    });

    expect(result.content).toBe("Done.\n\nThe edit is complete.");
    expect(result.parts).toEqual([
      { type: "final", text: "Done.\n\nThe edit is complete." },
    ]);
    expect(result.source).toBe("model");
  });

  it("uses outcome-code presentation when no visible final part exists", () => {
    const result = new FinalAssistantMessageService().build({
      terminalState: RUN_TERMINAL_STATES.FAILED_VALIDATION,
      outcomeCode: "FINALIZATION_MISSING_EVIDENCE",
      metadata: { missingEvidence: ["file_edit_or_diff"] },
    });

    expect(result.source).toBe("runtime");
    expect(result.content).toContain("required evidence is missing");
    expect(result.metadata.outcomeCode).toBe("FINALIZATION_MISSING_EVIDENCE");
    expect(result.parts).toHaveLength(1);
  });
});
