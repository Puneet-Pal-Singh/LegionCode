import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES, type RunTerminalState } from "@repo/shared-types";
import { FinalAssistantMessageService } from "./FinalAssistantMessageService.js";
import { projectTerminalSettlement } from "./TerminalSettlementProjector.js";

describe("terminal finalization matrix", () => {
  const terminalStates: RunTerminalState[] = [
    RUN_TERMINAL_STATES.COMPLETED,
    RUN_TERMINAL_STATES.FAILED_TOOL,
    RUN_TERMINAL_STATES.APPROVAL_DENIED,
    RUN_TERMINAL_STATES.INTERRUPTED,
    RUN_TERMINAL_STATES.FAILED_RUNTIME,
    RUN_TERMINAL_STATES.FAILED_VALIDATION,
  ];

  it.each(terminalStates)(
    "projects exactly one typed outcome and final part for %s",
    (terminalState) => {
      const settlement = projectTerminalSettlement({
        terminalState,
        contract: { requiredEvidence: [], missingEvidence: [], settled: true },
      });
      const final = new FinalAssistantMessageService().build({
        terminalState,
        outcomeCode: settlement.outcomeCode,
        finalParts: [],
      });

      expect(settlement.outcomeCode).toBeTypeOf("string");
      expect(final.parts).toHaveLength(1);
      expect(final.parts[0]?.type).toBe("final");
      expect(final.metadata.finalParts).toEqual(final.parts);
    },
  );

  it("projects missing evidence as one failed terminal outcome, never success", () => {
    const settlement = projectTerminalSettlement({
      terminalState: RUN_TERMINAL_STATES.COMPLETED,
      contract: {
        requiredEvidence: ["file_edit_or_diff"],
        missingEvidence: ["file_edit_or_diff"],
        settled: false,
      },
    });

    expect(settlement).toMatchObject({
      outcomeCode: "FINALIZATION_MISSING_EVIDENCE",
      terminalState: RUN_TERMINAL_STATES.FAILED_VALIDATION,
      terminalStatus: "FAILED",
    });
  });
});
