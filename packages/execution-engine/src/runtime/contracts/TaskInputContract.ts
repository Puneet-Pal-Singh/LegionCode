import type { TaskType } from "../types.js";

export const VALID_GIT_ACTIONS = [
  "git_clone",
  "git_diff",
  "git_commit",
  "git_push",
  "git_create_pull_request",
  "git_pull",
  "git_fetch",
  "git_branch_create",
  "git_branch_switch",
  "git_branch_list",
  "git_stage",
  "git_unstage",
  "git_status",
] as const;

const VAGUE_PATH_INPUT_PATTERNS = [
  /^(analyze|analyze the|check|check if|look at|examine|read the)/i,
  /^(if |when |make |ensure |install )/i,
  /^(find |search |locate |discover )/i,
  /^(the\s+)?(current\s+)?(workspace|repo|repository|project|codebase)$/i,
  /^(my|our|this|that|the)\s+(repo|repository|project|workspace|codebase)$/i,
  /^(the\s+)?(file|files|folder|directory|code)$/i,
  /^(this|that|it)$/i,
];

const VAGUE_COMMAND_INPUT_PATTERNS = [
  /^(if |when )/i,
  /^(check if|make sure|ensure)\b/i,
  /^(find|search|locate|discover)\s+(the|for)\b/i,
];

const MAX_TASK_INPUT_LENGTH = 500;
const WRAPPING_QUOTES_PATTERN = /^['"`]+|['"`]+$/g;
const TRAILING_PUNCTUATION_PATTERN = /[?!.,;:]+$/g;

export function isVagueTaskInput(value: string): boolean {
  return VAGUE_PATH_INPUT_PATTERNS.some((pattern) =>
    pattern.test(value.trim()),
  );
}

function isVagueCommandInput(value: string): boolean {
  return VAGUE_COMMAND_INPUT_PATTERNS.some((pattern) =>
    pattern.test(value.trim()),
  );
}

export function isConcretePathInput(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = normalizePathCandidate(value);
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_TASK_INPUT_LENGTH &&
    !isVagueTaskInput(normalized)
  );
}

export function isConcreteCommandInput(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_TASK_INPUT_LENGTH &&
    !isVagueCommandInput(normalized)
  );
}

export function isValidGitActionInput(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return VALID_GIT_ACTIONS.includes(
    value as (typeof VALID_GIT_ACTIONS)[number],
  );
}

export function hasValidTaskInput(
  taskType: TaskType | string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (taskType === "review") {
    return true;
  }

  if (!input || typeof input !== "object") {
    return false;
  }

  if (taskType === "analyze") {
    return isConcretePathInput(input.path);
  }

  if (taskType === "edit") {
    return (
      isConcretePathInput(input.path) &&
      typeof input.content === "string" &&
      input.content.length > 0
    );
  }

  if (taskType === "test" || taskType === "shell") {
    return isConcreteCommandInput(input.command);
  }

  if (taskType === "git") {
    return isValidGitActionInput(input.action);
  }

  return false;
}

function normalizePathCandidate(value: string): string {
  const trimmed = value.trim().replace(WRAPPING_QUOTES_PATTERN, "");
  const withoutMention = trimmed.startsWith("@")
    ? trimmed.slice(1).trim()
    : trimmed;
  return withoutMention.replace(TRAILING_PUNCTUATION_PATTERN, "").trim();
}
