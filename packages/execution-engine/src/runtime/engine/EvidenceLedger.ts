import type { ToolEvidenceKind } from "../tools/CodingToolRegistry.js";
import { getCodingToolDefinition } from "../tools/CodingToolRegistry.js";
import type { AgenticLoopToolLifecycleEvent } from "../types.js";

export type EvidenceKind = ToolEvidenceKind;

export type FinalizationEvidenceRequirement =
  | "file_read_or_search"
  | "file_edit_or_diff"
  | "command_run";

export interface EvidenceRecord {
  id: string;
  sourceEventId: string;
  kind: EvidenceKind;
  status: "observed" | "failed";
  recordedAt: string;
  toolCallId: string;
  toolName: string;
  path?: string;
  command?: string;
  detail?: string;
}

export interface FinalizationContract {
  requiredEvidence: FinalizationEvidenceRequirement[];
  missingEvidence: FinalizationEvidenceRequirement[];
  settled: boolean;
}

export function buildEvidenceLedger(
  lifecycle: readonly AgenticLoopToolLifecycleEvent[],
): EvidenceRecord[] {
  return lifecycle.flatMap((event) => {
    if (event.status !== "completed" && event.status !== "failed") {
      return [];
    }

    const definition = getCodingToolDefinition(event.toolName);
    const status = event.status === "completed" ? "observed" : "failed";
    const sourceEventId = `${event.toolCallId}:${event.status}`;
    return (definition?.evidenceKinds ?? []).map((kind) => ({
      id: `${sourceEventId}:${kind}`,
      sourceEventId,
      kind,
      status,
      recordedAt: event.recordedAt,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      path: readPath(event.metadata),
      command: readCommand(event.metadata),
      detail: event.detail,
    }));
  });
}

export function readFinalizationEvidenceRequirements(
  value: unknown,
): FinalizationEvidenceRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isFinalizationEvidenceRequirement);
}

export function evaluateFinalizationContract(input: {
  ledger: readonly EvidenceRecord[];
  requiredEvidence: readonly FinalizationEvidenceRequirement[];
}): FinalizationContract {
  const missingEvidence = input.requiredEvidence.filter(
    (requirement) => !hasEvidenceForRequirement(input.ledger, requirement),
  );
  return {
    requiredEvidence: [...input.requiredEvidence],
    missingEvidence,
    settled: missingEvidence.length === 0,
  };
}

export function hasEvidenceForRequirement(
  ledger: readonly EvidenceRecord[],
  requirement: FinalizationEvidenceRequirement,
): boolean {
  const kinds = {
    file_read_or_search: ["file_read", "file_search"],
    file_edit_or_diff: ["file_edit", "git_diff"],
    command_run: ["command_run"],
  } satisfies Record<FinalizationEvidenceRequirement, readonly EvidenceKind[]>;
  return ledger.some(
    (record) =>
      record.status === "observed" &&
      (kinds[requirement] as readonly EvidenceKind[]).includes(record.kind),
  );
}

function isFinalizationEvidenceRequirement(
  value: unknown,
): value is FinalizationEvidenceRequirement {
  return (
    value === "file_read_or_search" ||
    value === "file_edit_or_diff" ||
    value === "command_run"
  );
}

function readPath(metadata: AgenticLoopToolLifecycleEvent["metadata"]): string | undefined {
  if (!metadata) return undefined;
  return "path" in metadata && typeof metadata.path === "string"
    ? metadata.path
    : "filePath" in metadata && typeof metadata.filePath === "string"
      ? metadata.filePath
      : undefined;
}

function readCommand(metadata: AgenticLoopToolLifecycleEvent["metadata"]): string | undefined {
  return metadata?.family === "shell" ? metadata.command : undefined;
}
