import { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";
import type { IPlugin, PluginResult, LogCallback } from "../interfaces/types";
import { GitTools } from "../schemas/git";
import type {
  GitCommitIdentity,
  DiffContent,
  DiffHunk,
  FileStatus,
  GitStatusResponse,
} from "@repo/shared-types";
import {
  getWorkspaceRoot,
  normalizeRunId,
  resolveWorkspacePath,
  validateRepoRelativePath,
} from "./security/PathGuard";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";

const GIT_ACTIONS = [
  "status",
  "diff",
  "stage",
  "unstage",
  "commit",
  "push",
  "git_clone",
  "git_diff",
  "git_commit",
  "git_push",
  "git_pull",
  "git_fetch",
  "git_branch_create",
  "git_branch_switch",
  "git_branch_list",
  "git_stage",
  "git_status",
  "git_config",
] as const;

type GitAction = (typeof GIT_ACTIONS)[number];

const GitPayloadSchema = z.object({
  action: z.enum(GIT_ACTIONS),
  runId: z.string().optional(),
  url: z.string().optional(),
  token: z.string().optional(),
  replaceExisting: z.boolean().optional(),
  message: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
  branch: z.string().optional(),
  path: z.string().optional(),
  files: z.array(z.string()).optional(),
  remote: z.string().optional(),
  staged: z.boolean().optional(),
});

type GitPayload = z.infer<typeof GitPayloadSchema>;

const SAFE_GIT_REF_REGEX = /^[A-Za-z0-9._/-]{1,200}$/;
const CLONE_DESTINATION_NOT_EMPTY_PATTERN =
  /destination path .* already exists and is not an empty directory/i;
const BRANCH_PATHSPEC_MISSING_PATTERN =
  /pathspec .* did not match any file(?:\(s\))? known to git/i;
const MISSING_GIT_AUTHOR_ERROR =
  "Git commit author is not configured for this workspace commit request.";
const WRITE_GIT_AUTHOR_ERROR =
  "Git commit author could not be written to this workspace before committing.";

type CommitIdentityResolutionResult =
  | { success: true; identity: GitCommitIdentity }
  | { success: false; error: string };

export class GitPlugin implements IPlugin {
  name = "git";
  tools = GitTools;

  async execute(
    sandbox: Sandbox,
    payload: unknown,
    onLog?: LogCallback,
  ): Promise<PluginResult> {
    try {
      const toolboxContext = readToolboxCommandContext(payload);
      const parsed = GitPayloadSchema.parse(payload);
      const runId = normalizeRunId(parsed.runId ?? toolboxContext.runId);
      const worktree = getWorkspaceRoot(runId);

      await this.ensureWorkspace(sandbox, worktree, toolboxContext, runId);

      switch (parsed.action) {
        case "status":
        case "git_status":
          return await this.getStatus(sandbox, worktree, toolboxContext, runId);
        case "diff":
        case "git_diff":
          return await this.getDiff(
            sandbox,
            worktree,
            parsed.path,
            parsed.staged,
            toolboxContext,
            runId,
          );
        case "stage":
        case "git_stage":
          return await this.stageFiles(
            sandbox,
            worktree,
            parsed.files,
            toolboxContext,
            runId,
          );
        case "unstage":
          return await this.unstageFiles(
            sandbox,
            worktree,
            parsed.files,
            toolboxContext,
            runId,
          );
        case "commit":
        case "git_commit":
          return await this.commit(
            sandbox,
            worktree,
            parsed.message,
            parsed.files,
            parsed.authorName,
            parsed.authorEmail,
            parsed.token,
            toolboxContext,
            runId,
          );
        case "push":
        case "git_push":
          return await this.push(
            sandbox,
            worktree,
            parsed.remote,
            parsed.branch,
            parsed.token,
            toolboxContext,
            runId,
          );
        case "git_clone":
          return await this.clone(
            sandbox,
            worktree,
            parsed.url,
            parsed.token,
            parsed.replaceExisting,
            toolboxContext,
            runId,
            onLog,
          );
        case "git_pull":
          return await this.pull(
            sandbox,
            worktree,
            parsed.remote,
            parsed.branch,
            parsed.token,
            toolboxContext,
            runId,
          );
        case "git_fetch":
          return await this.fetch(
            sandbox,
            worktree,
            parsed.remote,
            parsed.token,
            toolboxContext,
            runId,
          );
        case "git_branch_create":
          return await this.createBranch(
            sandbox,
            worktree,
            parsed.branch,
            toolboxContext,
            runId,
          );
        case "git_branch_switch":
          return await this.switchBranch(
            sandbox,
            worktree,
            parsed.branch,
            toolboxContext,
            runId,
          );
        case "git_branch_list":
          return await this.listBranches(
            sandbox,
            worktree,
            toolboxContext,
            runId,
          );
        case "git_config":
          return this.validateTokenOnly(parsed.token);
        default:
          return { success: false, error: "Unsupported git action" };
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Git operation failed";
      return { success: false, error: message };
    }
  }

  private async ensureWorkspace(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<void> {
    await this.runToolboxCommand(
      sandbox,
      { command: "mkdir", args: ["-p", worktree], runId },
      ["mkdir"],
      toolboxContext,
      "git.prepare_workspace",
    );
  }

  private validateTokenOnly(token: string | undefined): PluginResult {
    if (!token || token.trim().length === 0) {
      return { success: false, error: "Token is required for git_config" };
    }
    if (containsIllegalTokenChars(token)) {
      return { success: false, error: "Invalid token format" };
    }
    return {
      success: true,
      output: "Token validated for authenticated git actions",
    };
  }

  private async clone(
    sandbox: Sandbox,
    worktree: string,
    url: string | undefined,
    token: string | undefined,
    replaceExisting: boolean | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    onLog?: LogCallback,
  ): Promise<PluginResult> {
    const safeUrl = validateCloneUrl(url);
    const authArgs = this.buildGitAuthArgs(token);

    if (onLog) {
      onLog(`[git/plugin] Cloning repository into ${worktree}\n`);
    }

    const result = await this.runCloneCommand(
      sandbox,
      authArgs,
      safeUrl,
      worktree,
      toolboxContext,
      runId,
    );
    if (
      result.exitCode !== 0 &&
      replaceExisting === true &&
      CLONE_DESTINATION_NOT_EMPTY_PATTERN.test(result.stderr)
    ) {
      const clearResult = await runSafeCommand(
        sandbox,
        withToolboxCommandContext(
          { command: "rm", args: ["-rf", worktree], runId },
          toolboxContext,
          "git.clear_workspace",
        ),
        ["rm"],
      );
      if (clearResult.exitCode !== 0) {
        return {
          success: false,
          error:
            clearResult.stderr ||
            "Failed to clear existing workspace before clone.",
        };
      }
      const retryResult = await this.runCloneCommand(
        sandbox,
        authArgs,
        safeUrl,
        worktree,
        toolboxContext,
        runId,
      );
      return buildGitResult(retryResult, "Repository cloned successfully");
    }
    return buildGitResult(result, "Repository cloned successfully");
  }

  private async runCloneCommand(
    sandbox: Sandbox,
    authArgs: string[],
    safeUrl: string,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    return await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: [...authArgs, "clone", safeUrl, worktree],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.clone",
    );
  }

  private async getStatus(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const statusResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "status", "--porcelain", "-b"],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.status",
    );

    if (statusResult.exitCode !== 0) {
      return { success: false, error: statusResult.stderr };
    }

    const repoIdentity = await this.getRepoIdentity(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );
    const commitIdentity = await this.readWorkspaceCommitIdentity(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );
    const parsed = this.parseStatus(
      statusResult.stdout,
      repoIdentity,
      commitIdentity,
    );
    return { success: true, output: JSON.stringify(parsed) };
  }

  private parseStatus(
    stdout: string,
    repoIdentity: string | null,
    commitIdentity: GitCommitIdentity | null,
  ): GitStatusResponse {
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    const branchLine = lines[0];
    let branch = "main";
    let ahead = 0;
    let behind = 0;

    if (branchLine && branchLine.startsWith("##")) {
      const match = branchLine.match(/##\s*(.+?)(?:\.\.\.|$)/);
      if (match && match[1]) {
        branch = match[1];
      }

      const aheadMatch = branchLine.match(/ahead\s+(\d+)/);
      const behindMatch = branchLine.match(/behind\s+(\d+)/);
      if (aheadMatch && aheadMatch[1]) {
        ahead = Number.parseInt(aheadMatch[1], 10);
      }
      if (behindMatch && behindMatch[1]) {
        behind = Number.parseInt(behindMatch[1], 10);
      }
    }

    const files: FileStatus[] = lines
      .slice(1)
      .flatMap((line) => parseStatusLine(line));

    return {
      files,
      ahead,
      behind,
      branch,
      repoIdentity,
      commitIdentity,
      hasStaged: files.some((file) => file.isStaged),
      hasUnstaged: files.some((file) => !file.isStaged),
      gitAvailable: true,
    };
  }

  private async readWorkspaceCommitIdentity(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<GitCommitIdentity | null> {
    const authorName = await this.readGitConfigValue(
      sandbox,
      worktree,
      "user.name",
      toolboxContext,
      runId,
      "git.status_author_name.read",
    );
    const authorEmail = await this.readGitConfigValue(
      sandbox,
      worktree,
      "user.email",
      toolboxContext,
      runId,
      "git.status_author_email.read",
    );
    if (authorName.length === 0 || authorEmail.length === 0) {
      return null;
    }

    return {
      authorName,
      authorEmail,
      source: "workspace_git_config",
      verified: false,
    };
  }

  private async getRepoIdentity(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<string | null> {
    const remoteResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "config", "--get", "remote.origin.url"],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.status.remote",
    );

    if (remoteResult.exitCode !== 0) {
      return null;
    }

    return normalizeRepoIdentity(remoteResult.stdout);
  }

  private async getDiff(
    sandbox: Sandbox,
    worktree: string,
    filePath: string | undefined,
    staged: boolean | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const args = [
      "-C",
      worktree,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--unified=999999",
    ];
    if (staged) {
      args.push("--cached");
    }
    const safeFilePath = filePath ? validateRepoRelativePath(filePath) : undefined;
    if (filePath) {
      args.push("--", safeFilePath ?? filePath);
    }

    const diffResult = await this.runToolboxCommand(
      sandbox,
      { command: "git", args, runId },
      ["git"],
      toolboxContext,
      "git.diff",
    );
    if (diffResult.exitCode !== 0) {
      return { success: false, error: diffResult.stderr };
    }

    if (safeFilePath && !staged && diffResult.stdout.trim().length === 0) {
      const untrackedDiff = await this.getUntrackedFileDiff(
        sandbox,
        worktree,
        safeFilePath,
        toolboxContext,
        runId,
      );
      if (untrackedDiff) {
        return { success: true, output: JSON.stringify(untrackedDiff) };
      }
    }

    const parsedDiff = this.parseDiff(diffResult.stdout, filePath);
    return { success: true, output: JSON.stringify(parsedDiff) };
  }

  private async getUntrackedFileDiff(
    sandbox: Sandbox,
    worktree: string,
    safeFilePath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<DiffContent | null> {
    const untrackedResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: [
          "-C",
          worktree,
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          safeFilePath,
        ],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.diff_untracked_check",
    );
    if (
      untrackedResult.exitCode !== 0 ||
      !untrackedResult.stdout
        .split("\n")
        .some((path) => path.trim() === safeFilePath)
    ) {
      return null;
    }

    const fileResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "cat",
        args: [resolveWorkspacePath(worktree, safeFilePath)],
        runId,
      },
      ["cat"],
      toolboxContext,
      "git.diff_untracked_read",
    );
    if (fileResult.exitCode !== 0) {
      return null;
    }

    return createUntrackedFileDiff(safeFilePath, fileResult.stdout);
  }

  private parseDiff(diffOutput: string, filePath?: string): DiffContent {
    const lines = diffOutput.split("\n");
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLineCursor = 0;
    let newLineCursor = 0;

    let oldPath = filePath || "";
    let newPath = filePath || "";
    let isNewFile = false;
    let isDeleted = false;

    for (const line of lines) {
      if (line.startsWith("--- ")) {
        oldPath = line.substring(4).replace(/^a\//, "");
        if (line.includes("/dev/null")) {
          isNewFile = true;
        }
      } else if (line.startsWith("+++ ")) {
        newPath = line.substring(4).replace(/^b\//, "");
        if (line.includes("/dev/null")) {
          isDeleted = true;
        }
      } else if (line.startsWith("@@")) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match && match[1] && match[3]) {
          oldLineCursor = Number.parseInt(match[1], 10);
          newLineCursor = Number.parseInt(match[3], 10);
          currentHunk = {
            oldStart: oldLineCursor,
            oldLines: Number.parseInt(match[2] || "1", 10),
            newStart: newLineCursor,
            newLines: Number.parseInt(match[4] || "1", 10),
            lines: [],
            header: line,
          };
        }
      } else if (
        currentHunk &&
        (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
      ) {
        const nextLine = createDiffLine(line, oldLineCursor, newLineCursor);
        oldLineCursor = nextLine.nextOldLineNumber;
        newLineCursor = nextLine.nextNewLineNumber;
        currentHunk.lines.push(nextLine.line);
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return {
      oldPath,
      newPath,
      hunks,
      isBinary: false,
      isNewFile,
      isDeleted,
    };
  }

  private async stageFiles(
    sandbox: Sandbox,
    worktree: string,
    files: string[] | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeFiles = normalizeFileList(files);
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "add", "--", ...safeFiles],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.stage",
    );

    return buildGitResult(result, "Files staged");
  }

  private async unstageFiles(
    sandbox: Sandbox,
    worktree: string,
    files: string[] | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeFiles = normalizeFileList(files);
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "reset", "HEAD", "--", ...safeFiles],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.unstage",
    );

    return buildGitResult(result, "Files unstaged");
  }

  private async commit(
    sandbox: Sandbox,
    worktree: string,
    message: string | undefined,
    files: string[] | undefined,
    authorName: string | undefined,
    authorEmail: string | undefined,
    token: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    if (!message || message.trim().length === 0) {
      return { success: false, error: "Commit message is required" };
    }
    if (/[\0\r\n]/.test(message)) {
      return {
        success: false,
        error: "Commit message contains invalid characters",
      };
    }

    if (files && files.length > 0) {
      const stageResult = await this.stageFiles(
        sandbox,
        worktree,
        files,
        toolboxContext,
        runId,
      );
      if (!stageResult.success) {
        return stageResult;
      }
    }

    const commitIdentityResult = await this.ensureCommitIdentity(
      sandbox,
      worktree,
      authorName,
      authorEmail,
      token,
      toolboxContext,
      runId,
    );
    if (!commitIdentityResult.success) {
      return {
        success: false,
        error: commitIdentityResult.error,
      };
    }

    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "commit", "-m", message],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.commit",
    );

    return buildGitCommitResult(result, commitIdentityResult.identity);
  }

  private async ensureCommitIdentity(
    sandbox: Sandbox,
    worktree: string,
    authorName: string | undefined,
    authorEmail: string | undefined,
    token: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<CommitIdentityResolutionResult> {
    const oauthIdentity = await this.resolveCommitIdentityFromToken(token);
    const explicitIdentity = normalizeExplicitCommitIdentity(
      authorName,
      authorEmail,
    );
    const existingAuthorName = await this.readGitConfigValue(
      sandbox,
      worktree,
      "user.name",
      toolboxContext,
      runId,
      "git.commit_author_name.read",
    );
    const existingAuthorEmail = await this.readGitConfigValue(
      sandbox,
      worktree,
      "user.email",
      toolboxContext,
      runId,
      "git.commit_author_email.read",
    );
    const existingIdentity =
      existingAuthorName.length > 0 && existingAuthorEmail.length > 0
        ? {
            authorName: existingAuthorName,
            authorEmail: existingAuthorEmail,
            source: "workspace_git_config" as const,
            verified: false,
          }
        : null;
    const preferredIdentity =
      oauthIdentity ?? explicitIdentity ?? existingIdentity;

    if (!preferredIdentity) {
      return {
        success: false,
        error: MISSING_GIT_AUTHOR_ERROR,
      };
    }

    if (
      existingIdentity &&
      existingIdentity.authorName === preferredIdentity.authorName &&
      existingIdentity.authorEmail === preferredIdentity.authorEmail
    ) {
      return {
        success: true,
        identity: preferredIdentity,
      };
    }

    const writeNameResult = await this.writeGitConfigValue(
      sandbox,
      worktree,
      "user.name",
      preferredIdentity.authorName,
      toolboxContext,
      runId,
      "git.commit_author_name.write",
    );
    if (!writeNameResult.success) {
      return {
        success: false,
        error: WRITE_GIT_AUTHOR_ERROR,
      };
    }

    const writeEmailResult = await this.writeGitConfigValue(
      sandbox,
      worktree,
      "user.email",
      preferredIdentity.authorEmail,
      toolboxContext,
      runId,
      "git.commit_author_email.write",
    );
    if (!writeEmailResult.success) {
      await this.restoreGitConfigValue(
        sandbox,
        worktree,
        "user.name",
        existingAuthorName,
        toolboxContext,
        runId,
        "git.commit_author_name.rollback",
      );
      return {
        success: false,
        error: WRITE_GIT_AUTHOR_ERROR,
      };
    }

    return {
      success: true,
      identity: preferredIdentity,
    };
  }

  private async resolveCommitIdentityFromToken(
    token: string | undefined,
  ): Promise<GitCommitIdentity | null> {
    const accessToken = token?.trim();
    if (!accessToken) {
      return null;
    }

    try {
      const profile = await this.fetchGitHubJson<Record<string, unknown>>(
        accessToken,
        "/user",
      );
      const login = readStringValue(profile.login);
      const id = readNumberValue(profile.id);
      const authorName = readStringValue(profile.name) ?? login ?? null;
      const directEmail = readStringValue(profile.email);

      const emailFromList = await this.resolvePrimaryEmailFromToken(accessToken);
      const authorEmail =
        directEmail ??
        emailFromList ??
        (login && id !== null ? `${id}+${login}@users.noreply.github.com` : null);

      if (!authorName || !authorEmail) {
        return null;
      }

      return {
        authorName,
        authorEmail,
        source: "github_profile",
        verified: Boolean(emailFromList),
      };
    } catch (error) {
      console.warn(
        "[git/commit-identity] Failed to resolve identity from GitHub token",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  private async resolvePrimaryEmailFromToken(
    token: string,
  ): Promise<string | null> {
    try {
      const emails = await this.fetchGitHubJson<
        Array<Record<string, unknown>>
      >(token, "/user/emails");
      const selected =
        emails.find((entry) => readBooleanValue(entry.primary) && readBooleanValue(entry.verified)) ??
        emails.find((entry) => readBooleanValue(entry.verified)) ??
        emails.find((entry) => readBooleanValue(entry.primary)) ??
        null;
      return selected ? (readStringValue(selected.email) ?? null) : null;
    } catch (error) {
      return null;
    }
  }

  private async fetchGitHubJson<T>(
    token: string,
    path: string,
  ): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Shadowbox-Git-Plugin/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub API error (${response.status}): ${text}`);
    }

    return JSON.parse(text) as T;
  }

  private async readGitConfigValue(
    sandbox: Sandbox,
    worktree: string,
    key: "user.name" | "user.email",
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    toolName: string,
  ): Promise<string> {
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "config", "--get", key],
        runId,
      },
      ["git"],
      toolboxContext,
      toolName,
    );
    if (result.exitCode !== 0) {
      return "";
    }
    return result.stdout.trim();
  }

  private async writeGitConfigValue(
    sandbox: Sandbox,
    worktree: string,
    key: "user.name" | "user.email",
    value: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    toolName: string,
  ): Promise<PluginResult> {
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "config", key, value],
        runId,
      },
      ["git"],
      toolboxContext,
      toolName,
    );
    if (result.exitCode === 0) {
      return { success: true };
    }

    return {
      success: false,
      error: WRITE_GIT_AUTHOR_ERROR,
    };
  }

  private async restoreGitConfigValue(
    sandbox: Sandbox,
    worktree: string,
    key: "user.name" | "user.email",
    previousValue: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    toolName: string,
  ): Promise<void> {
    if (previousValue.length > 0) {
      await this.writeGitConfigValue(
        sandbox,
        worktree,
        key,
        previousValue,
        toolboxContext,
        runId,
        toolName,
      );
      return;
    }

    await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "config", "--unset", key],
        runId,
      },
      ["git"],
      toolboxContext,
      toolName,
    );
  }

  private async push(
    sandbox: Sandbox,
    worktree: string,
    remote: string | undefined,
    branch: string | undefined,
    token: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeRemote = sanitizeRef(remote || "origin", "remote");
    const safeBranch =
      branch && branch.trim().length > 0
        ? sanitizeRef(branch, "branch")
        : undefined;
    const authArgs = this.buildGitAuthArgs(token);
    const args = [...authArgs, "-C", worktree, "push"];

    if (safeBranch) {
      args.push("-u");
      args.push(safeRemote);
      args.push(`HEAD:${safeBranch}`);
    } else {
      args.push(safeRemote);
    }

    const result = await this.runToolboxCommand(
      sandbox,
      { command: "git", args, runId },
      ["git"],
      toolboxContext,
      "git.push",
    );

    if (result.exitCode === 0) {
      return buildGitResult(result, "Changes pushed");
    }

    if (isNonFastForwardGitPushError(result.stderr)) {
      return {
        success: false,
        error: buildNonFastForwardPushError(safeRemote, safeBranch),
      };
    }

    return buildGitResult(result, "Changes pushed");
  }

  private async pull(
    sandbox: Sandbox,
    worktree: string,
    remote: string | undefined,
    branch: string | undefined,
    token: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeRemote = sanitizeRef(remote || "origin", "remote");
    const authArgs = this.buildGitAuthArgs(token);
    const args = [...authArgs, "-C", worktree, "pull", "--ff-only", safeRemote];

    if (branch && branch.trim().length > 0) {
      args.push(sanitizeRef(branch, "branch"));
    }

    const result = await this.runToolboxCommand(
      sandbox,
      { command: "git", args, runId },
      ["git"],
      toolboxContext,
      "git.pull",
    );
    return buildGitResult(result, "Changes pulled successfully");
  }

  private async fetch(
    sandbox: Sandbox,
    worktree: string,
    remote: string | undefined,
    token: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeRemote = sanitizeRef(remote || "origin", "remote");
    const authArgs = this.buildGitAuthArgs(token);
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: [...authArgs, "-C", worktree, "fetch", safeRemote],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.fetch",
    );
    return buildGitResult(result, "Fetched successfully");
  }

  private async createBranch(
    sandbox: Sandbox,
    worktree: string,
    branch: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    if (!branch) {
      return { success: false, error: "Branch name is required" };
    }
    const safeBranch = sanitizeRef(branch, "branch");
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "checkout", "-b", safeBranch],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.branch_create",
    );

    return buildGitResult(
      result,
      `Created and switched to branch: ${safeBranch}`,
    );
  }

  private async switchBranch(
    sandbox: Sandbox,
    worktree: string,
    branch: string | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    if (!branch) {
      return { success: false, error: "Branch name is required" };
    }
    const safeBranch = sanitizeRef(branch, "branch");
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "checkout", safeBranch],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.branch_switch",
    );
    if (result.exitCode === 0) {
      return buildGitResult(result, `Switched to branch: ${safeBranch}`);
    }

    // If the branch only exists on origin, create a local tracking branch.
    if (BRANCH_PATHSPEC_MISSING_PATTERN.test(result.stderr)) {
      const trackingResult = await this.runToolboxCommand(
        sandbox,
        {
          command: "git",
          args: ["-C", worktree, "checkout", "--track", `origin/${safeBranch}`],
          runId,
        },
        ["git"],
        toolboxContext,
        "git.branch_switch_track_remote",
      );
      if (trackingResult.exitCode === 0) {
        return {
          success: true,
          output: `Switched to tracking branch: ${safeBranch}`,
        };
      }
    }

    return buildGitResult(result, `Switched to branch: ${safeBranch}`);
  }

  private async listBranches(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "branch", "-a"],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.branch_list",
    );

    return {
      success: result.exitCode === 0,
      output: result.stdout || "No branches found",
      error: result.exitCode === 0 ? undefined : result.stderr,
    };
  }

  private buildGitAuthArgs(token: string | undefined): string[] {
    if (!token || token.trim().length === 0) {
      return [];
    }
    if (containsIllegalTokenChars(token)) {
      throw new Error("Invalid token format");
    }

    const authValue = Buffer.from(`x-access-token:${token}`, "utf8").toString(
      "base64",
    );
    return ["-c", `http.extraheader=AUTHORIZATION: basic ${authValue}`];
  }

  private async runToolboxCommand(
    sandbox: Sandbox,
    spec: Parameters<typeof withToolboxCommandContext>[0],
    allowlist: readonly string[],
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    toolName: string,
  ) {
    return await runSafeCommand(
      sandbox,
      withToolboxCommandContext(spec, toolboxContext, toolName),
      allowlist,
    );
  }
}

function parseStatusLine(line: string): FileStatus[] {
  if (line.length < 3) {
    return [];
  }

  const stagedStatus = line[0];
  const unstagedStatus = line[1];
  const filePath = line.substring(3).trim();

  let status: FileStatus["status"] = "modified";
  let isStaged = stagedStatus !== " " && stagedStatus !== "?";

  if (stagedStatus === "A" || unstagedStatus === "A") {
    status = "added";
  } else if (stagedStatus === "D" || unstagedStatus === "D") {
    status = "deleted";
  } else if (stagedStatus === "R" || unstagedStatus === "R") {
    status = "renamed";
  } else if (stagedStatus === "?" || unstagedStatus === "?") {
    status = "untracked";
    isStaged = false;
  }

  return [
    {
      path: filePath,
      status,
      additions: 0,
      deletions: 0,
      isStaged,
    },
  ];
}

function createDiffLine(
  line: string,
  oldLineNumber: number,
  newLineNumber: number,
): {
  line: DiffHunk["lines"][number];
  nextOldLineNumber: number;
  nextNewLineNumber: number;
} {
  if (line.startsWith("+")) {
    return {
      line: {
        type: "added",
        content: line.substring(1),
        newLineNumber,
      },
      nextOldLineNumber: oldLineNumber,
      nextNewLineNumber: newLineNumber + 1,
    };
  }

  if (line.startsWith("-")) {
    return {
      line: {
        type: "deleted",
        content: line.substring(1),
        oldLineNumber,
      },
      nextOldLineNumber: oldLineNumber + 1,
      nextNewLineNumber: newLineNumber,
    };
  }

  return {
    line: {
      type: "unchanged",
      content: line.substring(1),
      oldLineNumber,
      newLineNumber,
    },
    nextOldLineNumber: oldLineNumber + 1,
    nextNewLineNumber: newLineNumber + 1,
  };
}

function createUntrackedFileDiff(filePath: string, content: string): DiffContent {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return {
    oldPath: filePath,
    newPath: filePath,
    hunks:
      lines.length === 0
        ? []
        : [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lines.length,
              header: `@@ -0,0 +1,${lines.length} @@`,
              lines: lines.map((line, index) => ({
                type: "added",
                content: line,
                newLineNumber: index + 1,
              })),
            },
          ],
    isBinary: false,
    isNewFile: true,
    isDeleted: false,
  };
}

function normalizeFileList(files: string[] | undefined): string[] {
  if (!files || files.length === 0) {
    return ["."];
  }
  return files.map((file) => validateRepoRelativePath(file));
}

function normalizeExplicitCommitIdentity(
  authorName: string | undefined,
  authorEmail: string | undefined,
): GitCommitIdentity | null {
  const normalizedAuthorName = authorName?.trim() ?? "";
  const normalizedAuthorEmail = authorEmail?.trim() ?? "";
  if (!normalizedAuthorName || !normalizedAuthorEmail) {
    return null;
  }
  return {
    authorName: normalizedAuthorName,
    authorEmail: normalizedAuthorEmail,
    source: "user_input",
    verified: false,
  };
}

function sanitizeRef(value: string, label: "branch" | "remote"): string {
  const normalized = value.trim();
  if (!SAFE_GIT_REF_REGEX.test(normalized)) {
    throw new Error(`Invalid ${label} name`);
  }
  return normalized;
}

function validateCloneUrl(url: string | undefined): string {
  if (!url || url.trim().length === 0) {
    throw new Error("Clone URL is required");
  }

  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only https clone URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Tokenized clone URLs are not allowed");
  }
  return parsed.toString();
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
    if (!normalizedPath) {
      return null;
    }
    return `${parsed.host.toLowerCase()}/${normalizedPath}`;
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

function containsIllegalTokenChars(token: string): boolean {
  return /[\0\r\n]/.test(token);
}

function isNonFastForwardGitPushError(stderr: string): boolean {
  return /non-fast-forward|tip of your current branch is behind/i.test(stderr);
}

function buildNonFastForwardPushError(
  remote: string,
  branch: string | undefined,
): string {
  const branchLabel = branch ?? "current branch";
  return `Push failed because ${remote}/${branchLabel} already has newer commits. Your file changes are already committed locally. Sync the branch with git pull --ff-only and retry the push. If the branch cannot be fast-forwarded, resolve the branch conflict manually before retrying.`;
}

function buildGitResult(
  result: { exitCode: number; stdout: string; stderr: string },
  successMessage: string,
): PluginResult {
  return {
    success: result.exitCode === 0,
    output: result.exitCode === 0 ? successMessage : undefined,
    error:
      result.exitCode === 0
        ? undefined
        : buildGitCommandFailureMessage(result),
  };
}

function buildGitCommitResult(
  result: { exitCode: number; stdout: string; stderr: string },
  identity: GitCommitIdentity,
): PluginResult {
  return {
    success: result.exitCode === 0,
    output:
      result.exitCode === 0
        ? {
            content: "Changes committed",
            commitIdentity: {
              source: identity.source,
              verified: identity.verified,
            },
          }
        : undefined,
    error:
      result.exitCode === 0
        ? undefined
        : buildGitCommandFailureMessage(result),
  };
}

function buildGitCommandFailureMessage(result: {
  stdout: string;
  stderr: string;
}): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }

  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }

  return "Git command failed.";
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanValue(value: unknown): boolean {
  return value === true;
}
