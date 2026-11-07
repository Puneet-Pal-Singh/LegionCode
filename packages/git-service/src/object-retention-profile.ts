import { RunIdSchema } from "@repo/platform-protocol";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type GitCommandExecutor,
} from "./executor.js";
import { createGitCommandFailedError, GitServiceError } from "./errors.js";
import type { GitFilesystemContext } from "./types.js";
import { validateWorkspaceRoot } from "./validation.js";

/** Shared initial mutation profile; the native storage guard remains required. */
export async function assertGitObjectRetentionProfile(
  executor: GitCommandExecutor,
  workspace: GitFilesystemContext,
  timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<void> {
  const runId = RunIdSchema.parse(workspace.runId);
  const cwd = validateWorkspaceRoot(workspace.filesystemRoot);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_GIT_COMMAND_TIMEOUT_MS
  ) {
    throw new GitServiceError(
      "invalid_git_input",
      "Invalid Git profile deadline",
    );
  }
  const deadline = performance.now() + timeoutMs;
  const execute = async (args: readonly string[]) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
      throw new GitServiceError(
        "git_command_failed",
        "Git profile exceeded its deadline",
      );
    }
    const command = ["--no-replace-objects", ...args];
    const result = await executor.execute({
      runId,
      cwd,
      args: command,
      readOnlyProbe: true,
      timeoutMs: remaining,
    });
    if (result.indexPublication === "indeterminate") {
      throw new GitServiceError(
        "git_commit_indeterminate",
        "Git storage profile outcome is indeterminate",
      );
    }
    if (
      performance.now() > deadline ||
      result.stdout.length > 4096 ||
      result.stderr.length > 4096
    ) {
      throw new GitServiceError(
        "git_command_failed",
        "Git profile exceeded its bound",
      );
    }
    return { command, result };
  };
  const storage = await execute([
    "config",
    "--local",
    "--get",
    "extensions.refStorage",
  ]);
  if (storage.result.exitCode === 0) {
    if (storage.result.stdout.trim() !== "files") {
      throw new GitServiceError(
        "git_process_containment_unavailable",
        "This mutation profile requires files-format Git references",
      );
    }
  } else if (
    storage.result.exitCode !== 1 ||
    storage.result.stdout.length !== 0 ||
    storage.result.stderr.length !== 0
  ) {
    throw createGitCommandFailedError(
      storage.command,
      storage.result.exitCode,
      storage.result.stderr,
    );
  }
  const replacements = await execute([
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ]);
  if (replacements.result.exitCode !== 0) {
    throw createGitCommandFailedError(
      replacements.command,
      replacements.result.exitCode,
      replacements.result.stderr,
    );
  }
  if (replacements.result.stdout.length !== 0) {
    throw new GitServiceError(
      "git_process_containment_unavailable",
      "This mutation profile does not support replacement objects",
    );
  }
}
