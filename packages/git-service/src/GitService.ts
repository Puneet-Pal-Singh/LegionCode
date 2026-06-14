import { RunIdSchema } from "@repo/platform-protocol";

import type { GitCommandExecutor } from "./executor.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "./executor.js";
import { createGitCommandFailedError, GitServiceError } from "./errors.js";
import {
  validateBranchNamePolicy,
  validateBranchWithGit,
  validateRemoteName,
} from "./refs.js";
import {
  GIT_STATUS_PORCELAIN_V2_ARGS,
  parsePorcelainV2Status,
} from "./status.js";
import type {
  GitBranchValidationInput,
  GitBranchValidationResult,
  GitCommitInput,
  GitCommitResult,
  GitDiffInput,
  GitDiffResult,
  GitPushInput,
  GitPushResult,
  GitStageInput,
  GitStatusInput,
  GitStatusResult,
} from "./types.js";
import {
  validateExplicitRepoPaths,
  validateWorkspaceRoot,
} from "./validation.js";

const GIT_DIFF_ARGS = [
  "diff",
  "--no-ext-diff",
  "--find-renames",
  "--unified=999999",
] as const;
const GIT_COMMIT_MESSAGE_PATTERN = /[\0\r\n]/u;

export class DefaultGitService {
  constructor(private readonly executor: GitCommandExecutor) {}

  async getStatus(input: GitStatusInput): Promise<GitStatusResult> {
    const runId = RunIdSchema.parse(input.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspaceRoot);
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args: GIT_STATUS_PORCELAIN_V2_ARGS,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        GIT_STATUS_PORCELAIN_V2_ARGS,
        result.exitCode,
        getCommandErrorText(result),
      );
    }

    return parsePorcelainV2Status(result.stdout);
  }

  async getDiff(input: GitDiffInput): Promise<GitDiffResult> {
    const runId = RunIdSchema.parse(input.workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
    const paths =
      input.paths.length > 0 ? validateExplicitRepoPaths(input.paths) : [];
    const args: string[] = [...GIT_DIFF_ARGS];
    if (input.staged) {
      args.push("--cached");
    }
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        args,
        result.exitCode,
        getCommandErrorText(result),
      );
    }

    return {
      files: [],
      patch: result.stdout,
    };
  }

  async stageFiles(input: GitStageInput): Promise<GitStatusResult> {
    return await this.mutateExplicitPaths(input, "add");
  }

  async unstageFiles(input: GitStageInput): Promise<GitStatusResult> {
    return await this.mutateExplicitPaths(input, "reset", "HEAD");
  }

  async commit(input: GitCommitInput): Promise<GitCommitResult> {
    const runId = RunIdSchema.parse(input.workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
    const paths = validateExplicitRepoPaths(input.paths);
    const message = validateCommitMessage(input.message);
    await this.stageFiles({ workspace: input.workspace, paths });
    await this.writeCommitAuthor(input);

    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args: ["commit", "-m", message],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        ["commit", "-m", message],
        result.exitCode,
        getCommandErrorText(result),
      );
    }

    const commitSha = await this.readRequiredGitValue(input.workspace, [
      "rev-parse",
      "HEAD",
    ]);
    const branchName = await this.readRequiredGitValue(input.workspace, [
      "branch",
      "--show-current",
    ]);
    return {
      commitSha,
      branchName,
      committedPaths: paths,
    };
  }

  async push(input: GitPushInput): Promise<GitPushResult> {
    const runId = RunIdSchema.parse(input.workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
    const branchName = validateBranchNamePolicy(input.workspace.workingBranch);
    const remoteName = validateRemoteName(input.remoteName);
    const args = [
      ...validateGitAuthArgs(input.authArgs ?? []),
      "push",
      "-u",
      remoteName,
      `HEAD:${branchName}`,
    ];
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        args,
        result.exitCode,
        getCommandErrorText(result),
      );
    }

    return {
      remoteName,
      branchName,
      headSha: await this.readRequiredGitValue(input.workspace, [
        "rev-parse",
        "HEAD",
      ]),
    };
  }

  async validateBranch(
    input: GitBranchValidationInput,
  ): Promise<GitBranchValidationResult> {
    return validateBranchWithGit(this.executor, {
      runId: RunIdSchema.parse(input.runId),
      workspaceRoot: validateWorkspaceRoot(input.workspaceRoot),
      branchName: input.branchName,
    });
  }

  private async mutateExplicitPaths(
    input: GitStageInput,
    command: "add" | "reset",
    revision?: "HEAD",
  ): Promise<GitStatusResult> {
    const runId = RunIdSchema.parse(input.workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
    const paths = validateExplicitRepoPaths(input.paths);
    const args = revision
      ? [command, revision, "--", ...paths]
      : [command, "--", ...paths];
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        args,
        result.exitCode,
        getCommandErrorText(result),
      );
    }
    return await this.getStatus({
      runId,
      workspaceRoot,
    });
  }

  private async writeCommitAuthor(input: GitCommitInput): Promise<void> {
    await this.writeGitConfigValue(
      input.workspace,
      "user.name",
      input.author.name,
    );
    await this.writeGitConfigValue(
      input.workspace,
      "user.email",
      input.author.email,
    );
  }

  private async writeGitConfigValue(
    workspace: GitCommitInput["workspace"],
    key: "user.name" | "user.email",
    value: string,
  ): Promise<void> {
    const runId = RunIdSchema.parse(workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(workspace.filesystemRoot);
    const args = ["config", key, value];
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        args,
        result.exitCode,
        getCommandErrorText(result),
      );
    }
  }

  private async readRequiredGitValue(
    workspace: GitCommitInput["workspace"],
    args: readonly string[],
  ): Promise<string> {
    const runId = RunIdSchema.parse(workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(workspace.filesystemRoot);
    const result = await this.executor.execute({
      runId,
      cwd: workspaceRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        args,
        result.exitCode,
        getCommandErrorText(result),
      );
    }
    return result.stdout.trim();
  }
}

function getCommandErrorText(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return result.stderr.trim().length > 0 ? result.stderr : result.stdout;
}

function validateCommitMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length === 0 || GIT_COMMIT_MESSAGE_PATTERN.test(message)) {
    throw new GitServiceError(
      "invalid_git_input",
      "Commit message is required and cannot contain newlines",
    );
  }
  return normalized;
}

function validateGitAuthArgs(authArgs: readonly string[]): readonly string[] {
  if (authArgs.length === 0) {
    return [];
  }
  if (
    authArgs.length !== 2 ||
    authArgs[0] !== "-c" ||
    !authArgs[1]?.toLowerCase().startsWith("http.extraheader=")
  ) {
    throw new GitServiceError(
      "invalid_git_input",
      "Git auth args must be the canonical HTTP extraheader pair",
    );
  }
  return authArgs;
}
