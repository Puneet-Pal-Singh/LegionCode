import { describe, expect, it } from "vitest";
import type { AgenticLoopToolLifecycleEvent } from "../types.js";
import {
  buildEvidenceLedger,
  evaluateFinalizationContract,
  readFinalizationEvidenceRequirements,
} from "./EvidenceLedger.js";

describe("EvidenceLedger", () => {
  it("projects completed read and search lifecycle events into file-review evidence", () => {
    const ledger = buildEvidenceLedger([
      lifecycleEvent({
        toolCallId: "read-1",
        toolName: "read_file",
        metadata: {
          family: "read",
          path: "src/App.tsx",
          count: 20,
          truncated: false,
          loadedPaths: ["src/App.tsx"],
        },
      }),
      lifecycleEvent({
        toolCallId: "grep-1",
        toolName: "grep",
        metadata: {
          family: "search",
          path: "src",
          pattern: "finalize",
          count: 3,
          truncated: false,
          loadedPaths: ["src/App.tsx"],
        },
      }),
    ]);

    expect(ledger.map((record) => record.kind)).toEqual([
      "file_read",
      "file_search",
    ]);
    expect(
      evaluateFinalizationContract({
        ledger,
        requiredEvidence: ["file_read_or_search"],
      }).settled,
    ).toBe(true);
  });

  it("requires edit or diff evidence before settling edit finalization", () => {
    const ledger = buildEvidenceLedger([
      lifecycleEvent({
        toolCallId: "status-1",
        toolName: "git_status",
        metadata: {
          family: "git",
          displayText: "Status",
        },
      }),
    ]);

    expect(
      evaluateFinalizationContract({
        ledger,
        requiredEvidence: ["file_edit_or_diff"],
      }),
    ).toMatchObject({
      settled: false,
      missingEvidence: ["file_edit_or_diff"],
    });
  });

  it("accepts explicit edit evidence without inspecting the final answer text", () => {
    const ledger = buildEvidenceLedger([
      lifecycleEvent({
        toolCallId: "edit-1",
        toolName: "edit_file",
        metadata: {
          family: "edit",
          filePath: "src/App.tsx",
          additions: 2,
          deletions: 1,
        },
      }),
    ]);

    expect(
      evaluateFinalizationContract({
        ledger,
        requiredEvidence: ["file_edit_or_diff"],
      }).settled,
    ).toBe(true);
  });

  it("ignores unknown required evidence values from external metadata", () => {
    expect(
      readFinalizationEvidenceRequirements([
        "file_read_or_search",
        "prompt_intent",
      ]),
    ).toEqual(["file_read_or_search"]);
  });
});

function lifecycleEvent(
  input: Partial<AgenticLoopToolLifecycleEvent>,
): AgenticLoopToolLifecycleEvent {
  return {
    toolCallId: "tool-1",
    toolName: "read_file",
    status: "completed",
    mutating: false,
    recordedAt: "2026-07-04T00:00:00.000Z",
    ...input,
  };
}
