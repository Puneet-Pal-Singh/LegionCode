/**
 * DiffFormatter - Pure string serialization for git diffs
 *
 * Single responsibility: Convert GitDiff to string representation
 * No truncation, no decisions, pure serialization
 */
import type { GitDiff } from "@legioncode/context-assembly";

export interface DiffFormatOptions {
  includeStats?: boolean;
}

export function formatDiff(
  diff: GitDiff,
  options: DiffFormatOptions = {},
): string {
  const { includeStats = true } = options;
  const parts: string[] = [];

  parts.push(`--- Diff: ${diff.file} ---`);

  if (
    includeStats &&
    (diff.additions !== undefined || diff.deletions !== undefined)
  ) {
    const stats: string[] = [];
    if (diff.additions !== undefined) {
      stats.push(`+${diff.additions}`);
    }
    if (diff.deletions !== undefined) {
      stats.push(`-${diff.deletions}`);
    }
    parts.push(`Stats: ${stats.join(" ")}`);
  }

  if (diff.changeType) {
    parts.push(`Type: ${diff.changeType}`);
  }

  parts.push(diff.patch);

  return parts.join("\n");
}

export function formatDiffs(
  diffs: GitDiff[],
  options?: DiffFormatOptions,
): string {
  if (diffs.length === 0) {
    return "";
  }

  return diffs.map((diff) => formatDiff(diff, options)).join("\n\n");
}
