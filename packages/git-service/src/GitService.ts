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
import {
  captureGitWorkspaceSnapshot,
  diffGitWorkspaceSnapshots,
} from "./snapshot.js";
import type {
  GitBranchValidationInput,
  GitBranchValidationResult,
  GitBranchInput,
  GitBranchListInput,
  GitBranchListResult,
  GitBranchResult,
  GitCapturePatchInput,
  GitConfigValueInput,
  GitCommitInput,
  GitCommitResult,
  GitDiffInput,
  GitDiffResult,
  GitFetchInput,
  GitFileLineCount,
  GitFileLineCountsInput,
  GitPatchCaptureResult,
  GitPullInput,
  GitPushInput,
  GitPushResult,
  GitRepoIdentityInput,
  GitSnapshotDiffInput,
  GitSnapshotInput,
  GitWorkspaceSnapshot,
  GitStageInput,
  GitStatusInput,
  GitStatusResult,
  GitUntrackedFileDiffResult,
  GitUntrackedFileInput,
} from "./types.js";
import {
  validateExplicitRepoPaths,
  validateRepoRelativePath,
  validateWorkspaceRoot,
} from "./validation.js";

const GIT_DIFF_ARGS = [
  "diff",
  "--no-ext-diff",
  "--find-renames",
  "--unified=999999",
] as const;
const GIT_COMMIT_MESSAGE_PATTERN = /[\0\r\n]/u;
const BRANCH_PATHSPEC_MISSING_PATTERN =
  /pathspec .* did not match any file(?:\(s\))? known to git/i;

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

  async getFileLineCounts(
    input: GitFileLineCountsInput,
  ): Promise<readonly GitFileLineCount[]> {
    const runId = RunIdSchema.parse(input.workspace.runId);
    const workspaceRoot = validateWorkspaceRoot(input.workspace.filesystemRoot);
    const paths = validateExplicitRepoPaths(input.paths);
    const counts = new Map<string, Omit<GitFileLineCount, "path">>();
    await this.mergeNumstat(workspaceRoot, runId, counts, ["diff", "--numstat"]);
    await this.mergeNumstat(workspaceRoot, runId, counts, [
      "diff",
      "--cached",
      "--numstat",
    ]);
    for (const path of paths) {
      if (counts.has(path)) {
        continue;
      }
      const lineCount = await this.countUntrackedLines(input.workspace, path);
      if (lineCount !== null) {
        counts.set(path, { additions: lineCount, deletions: 0 });
      }
    }
    return paths.flatMap((path) => {
      const count = counts.get(path);
      return count ? [{ path, ...count }] : [];
    });
  }

  async getUntrackedFileDiff(
    input: GitUntrackedFileInput,
  ): Promise<GitUntrackedFileDiffResult | null> {
    const path = validateRepoRelativePath(input.path);
    const result = await this.executeGit(input.workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      path,
    ]);
    if (result.exitCode !== 0 || !hasExactPath(result.stdout, path)) {
      return null;
    }
    const diffResult = await this.executeGit(input.workspace, [
      "diff",
      "--binary",
      "--no-index",
      "--",
      "/dev/null",
      path,
    ]);
    if (diffResult.exitCode !== 0 && diffResult.exitCode !== 1) {
      throw createGitCommandFailedError(
        ["diff", "--binary", "--no-index", "--", "/dev/null", path],
        diffResult.exitCode,
        getCommandErrorText(diffResult),
      );
    }
    return { path, patch: diffResult.stdout };
  }

  async getRepoIdentity(
    input: GitRepoIdentityInput,
  ): Promise<string | null> {
    const remoteUrl = await this.readConfigValue({
      workspace: input.workspace,
      key: "remote.origin.url",
    });
    return remoteUrl ? normalizeRepoIdentity(remoteUrl) : null;
  }

  async readConfigValue(input: GitConfigValueInput): Promise<string | null> {
    const value = await this.readOptionalGitValue(input.workspace, [
      "config",
      "--get",
      input.key,
    ]);
    return value && value.length > 0 ? value : null;
  }

  async capturePatch(
    input: GitCapturePatchInput,
  ): Promise<GitPatchCaptureResult> {
    const trackedPatch = await this.captureTrackedPatch(input);
    const untrackedPatch = await this.captureUntrackedPatch(input);
    const baseCommitSha = await this.readOptionalGitValue(input.workspace, [
      "rev-parse",
      "HEAD",
    ]);
    const branch = await this.readOptionalGitValue(input.workspace, [
      "branch",
      "--show-current",
    ]);
    return {
      patch: [trackedPatch, untrackedPatch].filter(hasPatchContent).join("\n"),
      baseCommitSha,
      branch,
    };
  }

  async captureSnapshot(
    input: GitSnapshotInput,
  ): Promise<GitWorkspaceSnapshot> {
    return await captureGitWorkspaceSnapshot(this.executor, input);
  }

  async getSnapshotDiff(input: GitSnapshotDiffInput): Promise<GitDiffResult> {
    return await diffGitWorkspaceSnapshots(this.executor, input);
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

  async pull(input: GitPullInput): Promise<void> {
    const remoteName = validateRemoteName(input.remoteName);
    const args = [
      ...validateGitAuthArgs(input.authArgs ?? []),
      "pull",
      "--ff-only",
      remoteName,
    ];
    if (input.branchName && input.branchName.trim().length > 0) {
      args.push(validateBranchNamePolicy(input.branchName));
    }
    await this.executeRequired(input.workspace, args);
  }

  async fetch(input: GitFetchInput): Promise<void> {
    await this.executeRequired(input.workspace, [
      ...validateGitAuthArgs(input.authArgs ?? []),
      "fetch",
      validateRemoteName(input.remoteName),
    ]);
  }

  async createBranch(input: GitBranchInput): Promise<GitBranchResult> {
    const branchName = validateBranchNamePolicy(input.branchName);
    await this.executeRequired(input.workspace, ["checkout", "-b", branchName]);
    return {
      branchName,
      message: `Created and switched to branch: ${branchName}`,
    };
  }

  async switchBranch(input: GitBranchInput): Promise<GitBranchResult> {
    const branchName = validateBranchNamePolicy(input.branchName);
    const result = await this.executeGit(input.workspace, [
      "checkout",
      branchName,
    ]);
    if (result.exitCode === 0) {
      return { branchName, message: `Switched to branch: ${branchName}` };
    }
    if (BRANCH_PATHSPEC_MISSING_PATTERN.test(result.stderr)) {
      await this.executeRequired(input.workspace, [
        "checkout",
        "--track",
        `origin/${branchName}`,
      ]);
      return {
        branchName,
        message: `Switched to tracking branch: ${branchName}`,
      };
    }
    throw createGitCommandFailedError(
      ["checkout", branchName],
      result.exitCode,
      getCommandErrorText(result),
    );
  }

  async listBranches(input: GitBranchListInput): Promise<GitBranchListResult> {
    const result = await this.executeRequired(input.workspace, [
      "branch",
      "-a",
    ]);
    return {
      output: result.stdout || "No branches found",
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

  private async mergeNumstat(
    workspaceRoot: string,
    runId: string,
    counts: Map<string, Omit<GitFileLineCount, "path">>,
    args: readonly string[],
  ): Promise<void> {
    const result = await this.executor.execute({
      runId: RunIdSchema.parse(runId),
      cwd: workspaceRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      mergeNumstatIntoMap(result.stdout, counts);
    }
  }

  private async countUntrackedLines(
    workspace: GitFileLineCountsInput["workspace"],
    path: string,
  ): Promise<number | null> {
    const result = await this.executeGit(workspace, ["ls-files", "--others", "--exclude-standard", "--", path]);
    if (result.exitCode !== 0 || !hasExactPath(result.stdout, path)) {
      return null;
    }
    const countResult = await this.executeGit(workspace, [
      "diff",
      "--no-index",
      "--numstat",
      "--",
      "/dev/null",
      path,
    ]);
    if (countResult.exitCode !== 0 && countResult.exitCode !== 1) {
      return null;
    }
    return readFirstNumstatAddition(countResult.stdout);
  }

  private async captureTrackedPatch(
    input: GitCapturePatchInput,
  ): Promise<string> {
    const result = await this.executeRequired(input.workspace, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--find-renames",
    ]);
    return result.stdout;
  }

  private async captureUntrackedPatch(
    input: GitCapturePatchInput,
  ): Promise<string> {
    const paths = await this.listUntrackedPaths(input);
    const patches: string[] = [];
    for (const path of paths) {
      const result = await this.executeGit(input.workspace, [
        "diff",
        "--binary",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ]);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw createGitCommandFailedError(
          ["diff", "--binary", "--no-index", "--", "/dev/null", path],
          result.exitCode,
          getCommandErrorText(result),
        );
      }
      if (hasPatchContent(result.stdout)) {
        patches.push(result.stdout);
      }
    }
    return patches.join("\n");
  }

  private async listUntrackedPaths(
    input: GitCapturePatchInput,
  ): Promise<readonly string[]> {
    const result = await this.executeRequired(input.workspace, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
    ]);
    return result.stdout
      .split("\0")
      .filter((path) => shouldKeepPatchPath(path, input.internalPathPrefix));
  }

  private async executeRequired(
    workspace: GitFileLineCountsInput["workspace"],
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await this.executeGit(workspace, args);
    if (result.exitCode !== 0) {
      throw createGitCommandFailedError(
        args,
        result.exitCode,
        getCommandErrorText(result),
      );
    }
    return result;
  }

  private async executeGit(
    workspace: GitFileLineCountsInput["workspace"],
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return await this.executor.execute({
      runId: RunIdSchema.parse(workspace.runId),
      cwd: validateWorkspaceRoot(workspace.filesystemRoot),
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
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

  private async readOptionalGitValue(
    workspace: GitCommitInput["workspace"],
    args: readonly string[],
  ): Promise<string | null> {
    const result = await this.executeGit(workspace, args);
    if (result.exitCode !== 0) {
      return null;
    }
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
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

function mergeNumstatIntoMap(
  stdout: string,
  counts: Map<string, Omit<GitFileLineCount, "path">>,
): void {
  for (const line of stdout.split("\n")) {
    const entry = parseNumstatLine(line);
    if (!entry) {
      continue;
    }
    const existing = counts.get(entry.path);
    counts.set(entry.path, {
      additions: (existing?.additions ?? 0) + entry.additions,
      deletions: (existing?.deletions ?? 0) + entry.deletions,
    });
  }
}

function parseNumstatLine(
  line: string,
): { path: string; additions: number; deletions: number } | null {
  const [rawAdditions, rawDeletions, ...pathParts] = line.trim().split("\t");
  const path = pathParts.join("\t");
  const additions = Number.parseInt(rawAdditions ?? "", 10);
  const deletions = Number.parseInt(rawDeletions ?? "", 10);
  if (!path || Number.isNaN(additions) || Number.isNaN(deletions)) {
    return null;
  }
  return { path, additions, deletions };
}

function readFirstNumstatAddition(stdout: string): number | null {
  const firstEntry = stdout
    .split("\n")
    .map((line) => parseNumstatLine(line))
    .find((entry) => entry !== null);
  return firstEntry?.additions ?? null;
}

function hasExactPath(stdout: string, path: string): boolean {
  return stdout.split("\n").some((candidate) => candidate.trim() === path);
}

function shouldKeepPatchPath(
  path: string,
  internalPathPrefix: string | undefined,
): boolean {
  if (path.length === 0) {
    return false;
  }
  if (!internalPathPrefix) {
    return true;
  }
  return path !== internalPathPrefix && !path.startsWith(`${internalPathPrefix}/`);
}

function hasPatchContent(patch: string): boolean {
  return /\S/u.test(patch);
}

function normalizeRepoIdentity(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    const normalizedPath = normalizeRepoIdentityPath(sshMatch[2]);
    return normalizedPath
      ? `${sshMatch[1].toLowerCase()}/${normalizedPath}`
      : null;
  }
  try {
    const parsed = new URL(trimmed);
    const normalizedPath = normalizeRepoIdentityPath(parsed.pathname);
    return normalizedPath ? `${parsed.host.toLowerCase()}/${normalizedPath}` : null;
  } catch {
    return null;
  }
}

function normalizeRepoIdentityPath(pathname: string): string | null {
  const normalized = pathname
    .replace(/^\/+/u, "")
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
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
