import type { DiffHunk } from "@repo/shared-types";

export function countUnmodifiedLinesBeforeHunk(
  hunks: DiffHunk[],
  hunkIndex: number,
): number {
  const currentHunk = hunks[hunkIndex];
  if (!currentHunk) {
    return 0;
  }

  const previousHunk = hunks[hunkIndex - 1];
  const previousEnd = previousHunk
    ? previousHunk.newStart + previousHunk.newLines
    : 1;

  return Math.max(0, currentHunk.newStart - previousEnd);
}
