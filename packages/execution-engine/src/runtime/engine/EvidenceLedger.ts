import type { AgenticLoopToolLifecycleEvent } from "../types.js";

export type EvidenceKind =
  | "file_read"
  | "file_search"
  | "file_edit"
  | "git_diff"
  | "git_status"
  | "command_run";

export type FinalizationEvidenceRequirement =
  | "file_read_or_search"
  | "file_edit_or_diff"
  | "command_run";

export interface EvidenceRecord {
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
  return lifecycle.flatMap((event) => buildEvidenceRecordsForEvent(event));
}

export function readFinalizationEvidenceRequirements(
  value: unknown,
): FinalizationEvidenceRequirement[] {
  if (!Array.isArray(value)) {
    return [];
  }

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
  switch (requirement) {
    case "file_read_or_search":
      return ledger.some(
        (record) =>
          record.status === "observed" &&
          (record.kind === "file_read" || record.kind === "file_search"),
      );
    case "file_edit_or_diff":
      return ledger.some(
        (record) =>
          record.status === "observed" &&
          (record.kind === "file_edit" || record.kind === "git_diff"),
      );
    case "command_run":
      return ledger.some(
        (record) =>
          record.status === "observed" &&
          record.kind === "command_run",
      );
  }
}

function buildEvidenceRecordsForEvent(
  event: AgenticLoopToolLifecycleEvent,
): EvidenceRecord[] {
  if (event.status !== "completed" && event.status !== "failed") {
    return [];
  }

  const status = event.status === "completed" ? "observed" : "failed";
  const base = {
    status,
    recordedAt: event.recordedAt,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    detail: event.detail,
  } satisfies Omit<EvidenceRecord, "kind">;

  const metadata = event.metadata;
  if (metadata?.family === "read") {
    return [
      {
        ...base,
        kind: "file_read",
        path: metadata.path,
      },
    ];
  }

  if (metadata?.family === "search") {
    return [
      {
        ...base,
        kind: "file_search",
        path: metadata.path,
      },
    ];
  }

  if (metadata?.family === "edit") {
    return [
      {
        ...base,
        kind: "file_edit",
        path: metadata.filePath,
      },
    ];
  }

  if (metadata?.family === "git") {
    return buildGitEvidenceRecords(event, base, metadata.path);
  }

  if (metadata?.family === "shell") {
    const records: EvidenceRecord[] = [
      {
        ...base,
        kind: "command_run",
        command: metadata.command,
      },
    ];
    if (isGitDiffCommand(metadata.command)) {
      records.push({
        ...base,
        kind: "git_diff",
        command: metadata.command,
      });
    }
    if (isGitStatusCommand(metadata.command)) {
      records.push({
        ...base,
        kind: "git_status",
        command: metadata.command,
      });
    }
    return records;
  }

  return buildToolNameEvidenceRecords(event, base);
}

function buildGitEvidenceRecords(
  event: AgenticLoopToolLifecycleEvent,
  base: Omit<EvidenceRecord, "kind">,
  path?: string,
): EvidenceRecord[] {
  if (event.toolName === "git_diff") {
    return [{ ...base, kind: "git_diff", path }];
  }

  if (event.toolName === "git_status") {
    return [{ ...base, kind: "git_status", path }];
  }

  return [];
}

function buildToolNameEvidenceRecords(
  event: AgenticLoopToolLifecycleEvent,
  base: Omit<EvidenceRecord, "kind">,
): EvidenceRecord[] {
  switch (event.toolName) {
    case "read_file":
      return [{ ...base, kind: "file_read" }];
    case "grep":
    case "glob":
    case "list_files":
      return [{ ...base, kind: "file_search" }];
    case "write_file":
    case "edit_file":
    case "multi_edit":
    case "apply_patch":
      return [{ ...base, kind: "file_edit" }];
    case "git_diff":
      return [{ ...base, kind: "git_diff" }];
    case "git_status":
      return [{ ...base, kind: "git_status" }];
    case "bash":
      return [{ ...base, kind: "command_run" }];
    default:
      return [];
  }
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

function isGitDiffCommand(command: string): boolean {
  return splitShellCommandSegments(command).some((segment) =>
    /^git\s+diff(?:\s|$)/i.test(stripEnvAssignments(segment)),
  );
}

function isGitStatusCommand(command: string): boolean {
  return splitShellCommandSegments(command).some((segment) =>
    /^git\s+status(?:\s|$)/i.test(stripEnvAssignments(segment)),
  );
}

function splitShellCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function stripEnvAssignments(segment: string): string {
  return segment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/,
    "",
  );
}
