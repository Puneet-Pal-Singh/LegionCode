import { describe, expect, it } from "vitest";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import { enforceTerminalFinalEvidence } from "./TerminalFinalEvidencePolicy.js";

describe("enforceTerminalFinalEvidence", () => {
  it("downgrades a completion without typed final evidence to failure", () => {
    expect(
      enforceTerminalFinalEvidence({
        settlement: {
          terminalState: RUN_TERMINAL_STATES.COMPLETED,
          outcomeCode: "COMPLETED",
          terminalStatus: "COMPLETED",
        },
      }),
    ).toEqual({
      terminalState: RUN_TERMINAL_STATES.FAILED_VALIDATION,
      outcomeCode: "MODEL_FINAL_MISSING",
      terminalStatus: "FAILED",
    });
  });
});
