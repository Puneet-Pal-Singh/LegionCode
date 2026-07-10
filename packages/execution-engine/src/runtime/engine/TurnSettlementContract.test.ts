import { describe, expect, it } from "vitest";
import type { RunEvent } from "@repo/shared-types";
import type { FinalizationEvidenceRequirement } from "./EvidenceLedger.js";
import { settleFinalizationContract } from "./TurnSettlementContract.js";

function lifecycleEvent(
  input: Partial<Extract<RunEvent, { type: "tool.completed" }>>,
): Extract<RunEvent, { type: "tool.completed" }> {
  return {
    version: 1,
    eventId: "event-1",
    runId: "run-1",
    sessionId: "session-1",
    timestamp: "2026-07-07T00:00:00.000Z",
    source: "muscle",
    type: "tool.completed",
    payload: { toolId: "tool-1", toolName: "read_file", executionTimeMs: 1 },
    ...input,
  };
}

describe("TurnSettlementContract", () => {
  it("blocks a claim when typed evidence is missing", () => {
    const result = settleFinalizationContract({
      events: [],
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
      events: [
        lifecycleEvent({
          eventId: "event-bash",
          payload: {
            toolId: "bash-1",
            toolName: "bash",
            result: {
              metadata: {
                family: "shell",
                command: "anything",
                origin: "agent_tool",
                truncated: false,
              },
            },
            executionTimeMs: 1,
          },
        }),
      ],
      metadata: { requiredEvidence: ["command_run"] },
    });

    expect(result.contract.settled).toBe(true);
    expect(result.ledger[0]).toMatchObject({
      kind: "command_run",
      sourceEventId: "event-bash",
      command: "anything",
    });
  });

  it("does not classify an unknown tool from its name or metadata family", () => {
    const result = settleFinalizationContract({
      events: [
        lifecycleEvent({
          payload: {
            toolId: "unknown-1",
            toolName: "unknown_tool",
            result: { metadata: { family: "read", path: "src/App.tsx" } },
            executionTimeMs: 1,
          },
        }),
      ],
      metadata: { requiredEvidence: ["file_read_or_search"] },
    });

    expect(result.ledger).toEqual([]);
    expect(result.contract.settled).toBe(false);
  });
});
