/**
 * DiffAssembler - Dumb transformation for git diffs
 *
 * Single responsibility: Transform diffs to context message
 * No truncation, no decisions, pure transformation
 */
import type { GitDiff, ContextMessage } from "@legioncode/context-assembly";
import { formatDiffs } from "../formatters/DiffFormatter.js";

export function assembleDiffs(diffs: GitDiff[]): ContextMessage {
  const content = formatDiffs(diffs, {
    includeStats: true,
  });

  return {
    role: "user",
    content: content || "No diffs to display.",
    metadata: {
      source: "diffs",
    },
  };
}
