import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { ChangeLineStats, ChangedFileDiffState } from "./types";

export function calculateChangedFileTotals(
  files: FileStatus[],
  diffStates: Record<string, ChangedFileDiffState>,
): ChangeLineStats {
  return files.reduce<ChangeLineStats>(
    (totals, file) => {
      const stats = getFileStats(file, diffStates[file.path]);
      if (stats.additions === null || stats.deletions === null)
        return { additions: null, deletions: null };
      if (totals.additions === null || totals.deletions === null) return totals;
      return {
        additions: totals.additions + stats.additions,
        deletions: totals.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

export function getFileStats(
  file: FileStatus,
  diffState?: ChangedFileDiffState,
): ChangeLineStats {
  if (file.additions > 0 || file.deletions > 0)
    return { additions: file.additions, deletions: file.deletions };
  if (diffState?.diff) return calculateDiffStats(diffState.diff);
  if (diffState?.loading && file.additions === 0 && file.deletions === 0)
    return { additions: null, deletions: null };
  return { additions: file.additions, deletions: file.deletions };
}

export function calculateDiffStats(diff: DiffContent): ChangeLineStats {
  return diff.hunks.reduce(
    (totals, hunk) => ({
      additions:
        totals.additions +
        hunk.lines.filter((line) => line.type === "added").length,
      deletions:
        totals.deletions +
        hunk.lines.filter((line) => line.type === "deleted").length,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function splitPathForDisplay(path: string): {
  directory: string;
  name: string;
} {
  const lastSlashIndex = path.lastIndexOf("/");
  return lastSlashIndex < 0
    ? { directory: "", name: path }
    : {
        directory: path.slice(0, lastSlashIndex + 1),
        name: path.slice(lastSlashIndex + 1),
      };
}
