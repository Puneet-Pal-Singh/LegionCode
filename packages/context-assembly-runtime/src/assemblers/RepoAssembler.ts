/**
 * RepoAssembler - Dumb transformation for repository files
 *
 * Single responsibility: Transform repo snapshot to context message
 * No truncation, no decisions, pure transformation
 */
import type { RepoSnapshot, ContextMessage } from "@legioncode/context-assembly";
import { formatFiles } from "../formatters/FileFormatter.js";

export function assembleRepo(repo: RepoSnapshot): ContextMessage {
  const content = formatFiles(repo.files, {
    includePath: true,
    includeLanguage: true,
  });

  return {
    role: "user",
    content: content || "No files in repository.",
    metadata: {
      source: "repo",
    },
  };
}
