import type { FileStatus, GitCommitIdentity, GitStatusReady } from "./git.js";

/** Only the canonical Git status fields used by this pure response projection. */
export type GitStatusProjectionEntry =
  | {
      readonly kind: "untracked";
      readonly status: "untracked";
      readonly path: string;
    }
  | {
      readonly kind: "ordinary" | "renamed_or_copied" | "unmerged";
      readonly status:
        | "modified"
        | "added"
        | "deleted"
        | "renamed"
        | "copied"
        | "type_changed"
        | "unmerged"
        | "untracked";
      readonly path: string;
      readonly xy: { readonly index: string; readonly worktree: string };
    };

export interface GitStatusProjectionInput {
  readonly branch: {
    readonly ahead: number | null;
    readonly behind: number | null;
    readonly head: string | null;
  };
  readonly entries: readonly GitStatusProjectionEntry[];
}

export type GitStatusProjectionOptions = {
  /** Host policy applies to displayed files only, as in the existing projection. */
  readonly excludePath?: (path: string) => boolean;
};

export function buildGitStatusResponse(
  status: GitStatusProjectionInput,
  repoIdentity: string | null,
  commitIdentity: GitCommitIdentity | null,
  options: GitStatusProjectionOptions = {},
): GitStatusReady {
  const files = status.entries.flatMap((entry) =>
    toSharedFileStatus(entry, options),
  );
  return {
    files,
    ahead: status.branch.ahead ?? 0,
    behind: status.branch.behind ?? 0,
    branch: status.branch.head ?? "",
    repoIdentity,
    commitIdentity,
    hasStaged: status.entries.some((entry) => isStatusEntryStaged(entry)),
    hasUnstaged: status.entries.some((entry) => isStatusEntryUnstaged(entry)),
    gitAvailable: true,
  };
}

export function toSharedFileStatus(
  entry: GitStatusProjectionEntry,
  options: GitStatusProjectionOptions = {},
): FileStatus[] {
  if (options.excludePath?.(entry.path)) return [];
  return [
    {
      path: entry.path,
      status: toSharedStatus(entry),
      additions: 0,
      deletions: 0,
      isStaged: isStatusEntryStaged(entry),
    },
  ];
}

function toSharedStatus(entry: GitStatusProjectionEntry): FileStatus["status"] {
  switch (entry.status) {
    case "added":
    case "deleted":
    case "renamed":
    case "untracked":
      return entry.status;
    case "copied":
      return "added";
    case "type_changed":
    case "modified":
    case "unmerged":
      return "modified";
  }
}

function isStatusEntryStaged(entry: GitStatusProjectionEntry): boolean {
  if (entry.kind === "untracked") {
    return false;
  }
  return entry.xy.index !== ".";
}

function isStatusEntryUnstaged(entry: GitStatusProjectionEntry): boolean {
  if (entry.kind === "untracked") {
    return true;
  }
  return entry.xy.worktree !== ".";
}
