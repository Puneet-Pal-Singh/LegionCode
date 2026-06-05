import type { WorkspaceBootstrapMode } from "../types.js";
import { detectsMutation } from "./detectsMutation.js";

const GIT_WRITE_PROMPT_PATTERN =
  /\b(commit|stage|push|pull|fetch|sync|pull request|create pr|open pr|branch|checkout|merge|rebase|cherry-pick)\b/i;
const READ_ONLY_PROMPT_PATTERN =
  /\b(read|inspect|review|list|show|find|search|where|status|explain|analyze|audit|check)\b/i;
const FILE_OR_PATH_PROMPT_PATTERN =
  /(?:^|\s)@[\w./-]+|(?:^|\s)[\w./-]+\.[a-z0-9]{1,12}\b/i;
const WORKSPACE_NOUN_QUESTION_PATTERN =
  /\b(?:what|which)\b[\s\S]*\b(?:file|files|folder|folders|directory|directories|repo|repository|branch|branches|pr|pull request|changes|diff|status)\b/i;
const WORKSPACE_CONTINUATION_PROMPT_PATTERN =
  /^\s*(?:continue|retry|try again|resume|finish(?:\s+(?:it|that))?|do it)\b/i;

export function resolveWorkspaceBootstrapMode(
  prompt: string,
): WorkspaceBootstrapMode {
  if (isGitWritePrompt(prompt)) {
    return "git_write";
  }

  if (detectsMutation(prompt)) {
    return "mutation";
  }

  if (isExplicitReadOnlyPrompt(prompt)) {
    return "read_only";
  }

  return "mutation";
}

export function requiresWorkspaceBootstrap(prompt: string): boolean {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return false;
  }

  return (
    isGitWritePrompt(normalizedPrompt) ||
    detectsMutation(normalizedPrompt) ||
    isExplicitReadOnlyPrompt(normalizedPrompt) ||
    FILE_OR_PATH_PROMPT_PATTERN.test(normalizedPrompt) ||
    WORKSPACE_NOUN_QUESTION_PATTERN.test(normalizedPrompt) ||
    WORKSPACE_CONTINUATION_PROMPT_PATTERN.test(normalizedPrompt)
  );
}

export function isGitWritePrompt(prompt: string): boolean {
  return GIT_WRITE_PROMPT_PATTERN.test(prompt);
}

export function isExplicitReadOnlyPrompt(prompt: string): boolean {
  return READ_ONLY_PROMPT_PATTERN.test(prompt);
}
