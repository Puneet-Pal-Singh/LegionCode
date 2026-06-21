import type { DiffContent } from "@repo/shared-types";

export function countDiffAdditions(diff: DiffContent): number {
  return diff.hunks.reduce(
    (sum, hunk) =>
      sum + hunk.lines.filter((line) => line.type === "added").length,
    0,
  );
}

export function countDiffDeletions(diff: DiffContent): number {
  return diff.hunks.reduce(
    (sum, hunk) =>
      sum + hunk.lines.filter((line) => line.type === "deleted").length,
    0,
  );
}
