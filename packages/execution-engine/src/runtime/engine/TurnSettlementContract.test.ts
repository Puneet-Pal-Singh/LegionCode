import { describe, expect, it } from "vitest";
import type { Run } from "../run/index.js";
import {
  buildMissingEvidenceFinalText,
  settleFinalizationContract,
} from "./TurnSettlementContract.js";
import type { FinalizationEvidenceRequirement } from "./EvidenceLedger.js";
import type { AgenticLoopToolLifecycleEvent } from "../types.js";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_test_001",
    sessionId: "session_001",
    userId: "user_001",
    status: "running",
    mode: "auto_edit",
    providerId: "test",
    modelId: "test-model",
    startedAt: "2026-07-07T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    metadata: {
      agenticLoop: { toolLifecycle: [] },
      ...(overrides.metadata as Record<string, unknown> ?? {}),
    },
    ...overrides,
  } as Run;
}

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
  it("blocks finalization when file_read_or_search evidence is required but missing", () => {
    const run = createRun();
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["file_read_or_search"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.contract.settled).toBe(false);
    expect(result.contract.missingEvidence).toEqual(["file_read_or_search"]);
    expect(result.metadata.code).toBe("FINALIZATION_MISSING_EVIDENCE");
    expect(buildMissingEvidenceFinalText(result.contract)).toContain(
      "file_read_or_search",
    );
  });

  it("settles when required file_read_or_search evidence is present in the ledger", () => {
    const run = createRun({
      metadata: {
        agenticLoop: {
          toolLifecycle: [
            lifecycleEvent({ toolCallId: "read-1", toolName: "read_file", metadata: { family: "read", path: "src/App.tsx" } }),
          ],
        },
      },
    });
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["file_read_or_search"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.contract.settled).toBe(true);
    expect(result.contract.missingEvidence).toEqual([]);
    expect(result.metadata.code).toBeUndefined();
  });

  it("blocks finalization when file_edit_or_diff evidence is required but only read tools ran", () => {
    const run = createRun({
      metadata: {
        agenticLoop: {
          toolLifecycle: [
            lifecycleEvent({ toolCallId: "read-1", toolName: "read_file", metadata: { family: "read", path: "src/App.tsx" } }),
          ],
        },
      },
    });
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["file_edit_or_diff"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.contract.settled).toBe(false);
    expect(result.contract.missingEvidence).toEqual(["file_edit_or_diff"]);
  });

  it("settles edit claims when edit_file evidence is in the ledger", () => {
    const run = createRun({
      metadata: {
        agenticLoop: {
          toolLifecycle: [
            lifecycleEvent({ toolCallId: "edit-1", toolName: "edit_file", metadata: { family: "edit", filePath: "src/App.tsx" } }),
          ],
        },
      },
    });
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["file_edit_or_diff"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.contract.settled).toBe(true);
  });

  it("blocks finalization when command_run evidence is required but only read tools ran", () => {
    const run = createRun({
      metadata: {
        agenticLoop: {
          toolLifecycle: [
            lifecycleEvent({ toolCallId: "read-1", toolName: "read_file", metadata: { family: "read", path: "src/App.tsx" } }),
          ],
        },
      },
    });
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["command_run"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.contract.settled).toBe(false);
    expect(result.contract.missingEvidence).toEqual(["command_run"]);
  });

  it("settles tests-passed claims when bash command_run evidence is in the ledger", () => {
    const run = createRun({
      metadata: {
        agenticLoop: {
          toolLifecycle: [
            lifecycleEvent({ toolCallId: "bash-1", toolName: "bash", metadata: { family: "shell", command: "npm test" } }),
          ],
        },
      },
    });
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["command_run"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.contract.settled).toBe(true);
  });

  it("records evidence ledger in metadata when evidence is present", () => {
    const run = createRun({
      metadata: {
        agenticLoop: {
          toolLifecycle: [
            lifecycleEvent({ toolCallId: "read-1", toolName: "read_file", metadata: { family: "read", path: "src/App.tsx" } }),
          ],
        },
      },
    });
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["file_read_or_search"] as FinalizationEvidenceRequirement[] },
    });

    expect(result.metadata.evidenceLedger).toBeDefined();
    expect(Array.isArray(result.metadata.evidenceLedger)).toBe(true);
    expect(result.metadata.evidenceLedger.length).toBe(1);
  });

  it("produces stable typed text for missing evidence", () => {
    const run = createRun();
    const result = settleFinalizationContract({
      run,
      metadata: { requiredEvidence: ["file_read_or_search"] as FinalizationEvidenceRequirement[] },
    });

    const text = buildMissingEvidenceFinalText(result.contract);
    expect(text).toContain("cannot finalize that answer");
    expect(text).toContain("file_read_or_search");
    expect(text).not.toContain("undefined");
    expect(text).toContain("Missing evidence:");
  });
});
