import { RunIdSchema } from "@repo/platform-protocol";

import type { GitCommandExecutor } from "./executor.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "./executor.js";
import { createInvalidBranchRefError } from "./errors.js";
import type {
  GitBranchValidationInput,
  GitBranchValidationResult,
} from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";

const BRANCH_CHECK_ARGS = ["check-ref-format", "--branch"] as const;
const MAX_REMOTE_NAME_LENGTH = 128;
const WHITESPACE_PATTERN = /\s/u;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DELETE_CHARACTER_CODE = 127;
const MAX_CONTROL_CHARACTER_CODE = 31;

export function validateBranchNamePolicy(branchName: string): string {
  const normalized = branchName.trim();
  if (normalized !== branchName || normalized.length === 0) {
    throw createInvalidBranchRefError(branchName, "Branch name is empty");
  }
  if (branchName.startsWith("-")) {
    throw createInvalidBranchRefError(branchName, "Branch starts with dash");
  }
  if (branchName === "@" || branchName.startsWith("@{")) {
    throw createInvalidBranchRefError(branchName, "Branch uses reflog syntax");
  }
  if (hasForbiddenBranchPattern(branchName)) {
    throw createInvalidBranchRefError(branchName, "Branch has unsafe syntax");
  }
  return branchName;
}

export function validateRemoteName(remoteName: string): string {
  const normalized = remoteName.trim();
  if (
    normalized !== remoteName ||
    remoteName.length === 0 ||
    remoteName.length > MAX_REMOTE_NAME_LENGTH
  ) {
    throw createInvalidBranchRefError(remoteName, "Remote name is invalid");
  }
  if (!REMOTE_NAME_PATTERN.test(remoteName)) {
    throw createInvalidBranchRefError(remoteName, "Remote name is unsafe");
  }
  return remoteName;
}

export async function validateBranchWithGit(
  executor: GitCommandExecutor,
  input: GitBranchValidationInput,
): Promise<GitBranchValidationResult> {
  const branchName = validateBranchNamePolicy(input.branchName);
  const runId = RunIdSchema.parse(input.runId);
  const workspaceRoot = validateWorkspaceRoot(input.workspaceRoot);
  const result = await executor.execute({
    runId,
    cwd: workspaceRoot,
    args: [...BRANCH_CHECK_ARGS, branchName],
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    throw createInvalidBranchRefError(
      branchName,
      result.stderr || "git check-ref-format rejected branch",
    );
  }

  return {
    branchName,
    checkedRef: result.stdout.trim() || branchName,
  };
}

function hasForbiddenBranchPattern(branchName: string): boolean {
  return (
    hasControlCharacter(branchName) ||
    WHITESPACE_PATTERN.test(branchName) ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.includes("@{") ||
    branchName.includes("\\") ||
    branchName.includes("~") ||
    branchName.includes("^") ||
    branchName.includes(":") ||
    branchName.includes("?") ||
    branchName.includes("*") ||
    branchName.includes("[") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.split("/").some(isForbiddenBranchPathSegment)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const characterCode = character.charCodeAt(0);
    if (
      characterCode <= MAX_CONTROL_CHARACTER_CODE ||
      characterCode === DELETE_CHARACTER_CODE
    ) {
      return true;
    }
  }
  return false;
}

function isForbiddenBranchPathSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment.startsWith(".") ||
    segment.endsWith(".lock")
  );
}
