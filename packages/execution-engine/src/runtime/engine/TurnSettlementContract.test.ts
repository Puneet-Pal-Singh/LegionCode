import { describe, expect, it } from "vitest";
import type { AgenticLoopToolLifecycleEvent } from "../types.js";
import type { FinalizationEvidenceRequirement } from "./EvidenceLedger.js";
import { settleFinalizationContract } from "./TurnSettlementContract.js";

function lifecycleEvent(
  input: Partial<AgenticLoopToolLifecycleEvent>,
): AgenticLoopToolLifecycleEvent {
  return {
    toolCallId: "tool-1",
    toolName: "read_file",
    status: "completed",
    mutating: false,
    recordedAt: "2026-07-07T00:00:00.000Z",
    ...input,
  };
}

describe("TurnSettlementContract", () => {
  it("blocks a claim when typed evidence is missing", () => {
    const result = settleFinalizationContract({
      lifecycle: [],
      metadata: {
        requiredEvidence: ["file_read_or_search"] as FinalizationEvidenceRequirement[],
      },
    });

    expect(result.contract).toMatchObject({
      settled: false,
      missingEvidence: ["file_read_or_search"],
    });
  });

  it("settles from registry evidence descriptors, not command text", () => {
    const result = settleFinalizationContract({
      lifecycle: [
        lifecycleEvent({
          toolCallId: "bash-1",
          toolName: "bash",
          metadata: { family: "shell", command: "anything" },
        }),
      ],
      metadata: { requiredEvidence: ["command_run"] },
    });

    expect(result.contract.settled).toBe(true);
    expect(result.ledger[0]).toMatchObject({
      kind: "command_run",
      sourceEventId: "bash-1:completed",
      command: "anything",
    });
  });

  it("does not classify an unknown tool from its name or metadata family", () => {
    const result = settleFinalizationContract({
      lifecycle: [
        lifecycleEvent({
          toolName: "unknown_tool",
          metadata: { family: "read", path: "src/App.tsx" },
        }),
      ],
      metadata: { requiredEvidence: ["file_read_or_search"] },
    });

    expect(result.ledger).toEqual([]);
    expect(result.contract.settled).toBe(false);
  });
});
