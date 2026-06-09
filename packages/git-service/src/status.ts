import { GitServiceError, createMalformedStatusOutputError } from "./errors.js";
import type {
  GitBranchStatus,
  GitChangedFileStatus,
  GitStatusCode,
  GitStatusEntry,
  GitStatusResult,
  GitStatusXY,
  OrdinaryGitStatusEntry,
  RenamedOrCopiedGitStatusEntry,
  UnmergedGitStatusEntry,
  UntrackedGitStatusEntry,
} from "./types.js";

type MutableGitBranchStatus = {
  -readonly [Key in keyof GitBranchStatus]: GitBranchStatus[Key];
};

export const GIT_STATUS_PORCELAIN_V2_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--untracked-files=all",
  "--renames",
] as const;

const BRANCH_DETACHED_HEAD = "(detached)";
const COPY_SCORE_PREFIX = "C";
const RENAME_SCORE_PREFIX = "R";
const STATUS_CODE_VALUES = [
  ".",
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
] as const;

function createEmptyBranchStatus(): MutableGitBranchStatus {
  return {
    oid: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    detached: false,
  };
}

export function parsePorcelainV2Status(output: string): GitStatusResult {
  const tokens = output.split("\0");
  const entries: GitStatusEntry[] = [];
  const branch = createEmptyBranchStatus();

  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record === undefined || record === "") {
      continue;
    }
    if (record.startsWith("# ")) {
      applyBranchHeader(branch, record);
      continue;
    }
    const parsed = parseStatusRecord(record, tokens[index + 1]);
    entries.push(parsed.entry);
    index += parsed.consumedExtraTokens;
  }

  return {
    branch: { ...branch },
    entries,
    changedFileCount: entries.length,
    isDirty: entries.length > 0,
  };
}

function parseStatusRecord(
  record: string,
  nextToken: string | undefined,
): { entry: GitStatusEntry; consumedExtraTokens: number } {
  if (record.startsWith("1 ")) {
    return { entry: parseOrdinaryRecord(record), consumedExtraTokens: 0 };
  }
  if (record.startsWith("2 ")) {
    return {
      entry: parseRenamedOrCopiedRecord(record, nextToken),
      consumedExtraTokens: 1,
    };
  }
  if (record.startsWith("u ")) {
    return { entry: parseUnmergedRecord(record), consumedExtraTokens: 0 };
  }
  if (record.startsWith("? ")) {
    return { entry: parseUntrackedRecord(record), consumedExtraTokens: 0 };
  }
  throw new GitServiceError(
    "unsupported_status_record",
    "Unsupported porcelain-v2 status record",
    { record },
  );
}

function applyBranchHeader(
  branch: MutableGitBranchStatus,
  record: string,
): void {
  const header = record.slice(2);
  if (header.startsWith("branch.oid ")) {
    branch.oid = parseOptionalHeaderValue(header, "branch.oid ");
    return;
  }
  if (header.startsWith("branch.head ")) {
    const head = parseOptionalHeaderValue(header, "branch.head ");
    branch.head = head;
    branch.detached = head === BRANCH_DETACHED_HEAD;
    return;
  }
  if (header.startsWith("branch.upstream ")) {
    branch.upstream = parseOptionalHeaderValue(header, "branch.upstream ");
    return;
  }
  if (header.startsWith("branch.ab ")) {
    applyAheadBehindHeader(branch, header);
  }
}

function parseOptionalHeaderValue(
  header: string,
  prefix: string,
): string | null {
  const value = header.slice(prefix.length);
  return value.length > 0 ? value : null;
}

function applyAheadBehindHeader(
  branch: MutableGitBranchStatus,
  header: string,
): void {
  const match = /^branch\.ab \+(\d+) -(\d+)$/.exec(header);
  if (match === null) {
    throw createMalformedStatusOutputError(header, "Invalid branch.ab header");
  }
  branch.ahead = Number(match[1]);
  branch.behind = Number(match[2]);
}

function parseOrdinaryRecord(record: string): OrdinaryGitStatusEntry {
  const { fields, path } = splitFixedFields(record, 8);
  const xy = parseXY(getField(fields, 1, record), record);
  return {
    kind: "ordinary",
    status: mapChangedFileStatus(xy),
    xy,
    submodule: getField(fields, 2, record),
    headMode: getField(fields, 3, record),
    indexMode: getField(fields, 4, record),
    worktreeMode: getField(fields, 5, record),
    headObjectId: getField(fields, 6, record),
    indexObjectId: getField(fields, 7, record),
    path,
  };
}

function parseRenamedOrCopiedRecord(
  record: string,
  previousPath: string | undefined,
): RenamedOrCopiedGitStatusEntry {
  if (previousPath === undefined || previousPath === "") {
    throw createMalformedStatusOutputError(record, "Missing previous path");
  }
  const { fields, path } = splitFixedFields(record, 9);
  const score = parseRenameScore(getField(fields, 8, record), record);
  const xy = parseXY(getField(fields, 1, record), record);
  return {
    kind: "renamed_or_copied",
    status: score.kind,
    xy,
    submodule: getField(fields, 2, record),
    headMode: getField(fields, 3, record),
    indexMode: getField(fields, 4, record),
    worktreeMode: getField(fields, 5, record),
    headObjectId: getField(fields, 6, record),
    indexObjectId: getField(fields, 7, record),
    score: score.value,
    path,
    previousPath,
  };
}

function parseUnmergedRecord(record: string): UnmergedGitStatusEntry {
  const { fields, path } = splitFixedFields(record, 10);
  return {
    kind: "unmerged",
    status: "unmerged",
    xy: parseXY(getField(fields, 1, record), record),
    submodule: getField(fields, 2, record),
    stageOneMode: getField(fields, 3, record),
    stageTwoMode: getField(fields, 4, record),
    stageThreeMode: getField(fields, 5, record),
    worktreeMode: getField(fields, 6, record),
    stageOneObjectId: getField(fields, 7, record),
    stageTwoObjectId: getField(fields, 8, record),
    stageThreeObjectId: getField(fields, 9, record),
    path,
  };
}

function parseUntrackedRecord(record: string): UntrackedGitStatusEntry {
  const path = record.slice(2);
  if (path.length === 0) {
    throw createMalformedStatusOutputError(record, "Missing untracked path");
  }
  return {
    kind: "untracked",
    status: "untracked",
    path,
  };
}

function splitFixedFields(
  record: string,
  fixedFieldCount: number,
): { fields: readonly string[]; path: string } {
  const fields: string[] = [];
  let startIndex = 0;

  for (let index = 0; index < fixedFieldCount; index += 1) {
    const delimiterIndex = record.indexOf(" ", startIndex);
    if (delimiterIndex < 0) {
      throw createMalformedStatusOutputError(record, "Missing path field");
    }
    fields.push(record.slice(startIndex, delimiterIndex));
    startIndex = delimiterIndex + 1;
  }

  const path = record.slice(startIndex);
  if (path.length === 0) {
    throw createMalformedStatusOutputError(record, "Missing path field");
  }
  return { fields, path };
}

function getField(
  fields: readonly string[],
  index: number,
  record: string,
): string {
  const field = fields[index];
  if (field === undefined) {
    throw createMalformedStatusOutputError(record, "Missing fixed field");
  }
  return field;
}

function parseXY(value: string, record: string): GitStatusXY {
  if (value.length !== 2) {
    throw createMalformedStatusOutputError(record, "Invalid XY status");
  }
  return {
    index: parseStatusCode(value[0], record),
    worktree: parseStatusCode(value[1], record),
  };
}

function parseStatusCode(value: string | undefined, record: string): GitStatusCode {
  if (value === undefined || !isStatusCode(value)) {
    throw createMalformedStatusOutputError(record, "Invalid status code");
  }
  return value;
}

function isStatusCode(value: string): value is GitStatusCode {
  return STATUS_CODE_VALUES.includes(value as GitStatusCode);
}

function parseRenameScore(
  value: string,
  record: string,
): { kind: "renamed" | "copied"; value: number } {
  const prefix = value.slice(0, 1);
  const score = Number(value.slice(1));
  if (!Number.isInteger(score) || score < 0) {
    throw createMalformedStatusOutputError(record, "Invalid rename score");
  }
  if (prefix === RENAME_SCORE_PREFIX) {
    return { kind: "renamed", value: score };
  }
  if (prefix === COPY_SCORE_PREFIX) {
    return { kind: "copied", value: score };
  }
  throw createMalformedStatusOutputError(record, "Invalid rename kind");
}

function mapChangedFileStatus(xy: GitStatusXY): GitChangedFileStatus {
  if (xy.index === "A" || xy.worktree === "A") {
    return "added";
  }
  if (xy.index === "D" || xy.worktree === "D") {
    return "deleted";
  }
  if (xy.index === "T" || xy.worktree === "T") {
    return "type_changed";
  }
  return "modified";
}
