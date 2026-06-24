import { Sandbox } from "@cloudflare/sandbox";
import {
  DefaultGitService,
  GitServiceError,
  type GitFileLineCount,
  type GitPatchCaptureResult,
  type GitStatusEntry,
  type GitStatusResult,
} from "@repo/git-service";
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
  validateRepoRelativePath,
} from "./security/PathGuard";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";
import { SandboxGitCommandExecutor } from "./git/SandboxGitCommandExecutor";

const GIT_ACTIONS = [
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
  "git_unstage",
  "git_status",
  "git_patch_capture",
  "git_patch_apply",
] as const;

type GitAction = (typeof GIT_ACTIONS)[number];

const GitPayloadSchema = z.object({
  action: z.enum(GIT_ACTIONS),
  runId: z.string().optional(),
  url: z.string().optional(),
  token: z.string().optional(),
  message: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
  branch: z.string().optional(),
  path: z.string().optional(),
  files: z.array(z.string()).optional(),
  remote: z.string().optional(),
  staged: z.boolean().optional(),
  patch: z.string().optional(),
  dryRun: z.boolean().optional(),
});

type GitPayload = z.infer<typeof GitPayloadSchema>;

const SAFE_GIT_REF_REGEX = /^[A-Za-z0-9._/-]{1,200}$/;
const MISSING_GIT_AUTHOR_ERROR =
  "Git commit author is not configured for this workspace commit request.";
const PATCH_WORK_DIR = ".shadowbox";

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
        case "git_status":
          return await this.getStatus(sandbox, worktree, toolboxContext, runId);
        case "git_patch_capture":
          return await this.capturePatch(
            sandbox,
            worktree,
            toolboxContext,
            runId,
          );
        case "git_patch_apply":
          return await this.applyPatch(
            sandbox,
            worktree,
            parsed.patch,
            parsed.dryRun,
            toolboxContext,
            runId,
          );
        case "git_diff":
          return await this.getDiff(
            sandbox,
            worktree,
            parsed.path,
            parsed.staged,
            toolboxContext,
            runId,
          );
        case "git_stage":
          return await this.stageFiles(
            sandbox,
            worktree,
            parsed.files,
            toolboxContext,
            runId,
          );
        case "git_unstage":
          return await this.unstageFiles(
            sandbox,
            worktree,
            parsed.files,
            toolboxContext,
            runId,
          );
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
        default:
          return { success: false, error: "Unsupported git action" };
      }
    } catch (error: unknown) {
      return { success: false, error: getGitServiceErrorMessage(error) };
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

  private async clone(
    sandbox: Sandbox,
    worktree: string,
    url: string | undefined,
    token: string | undefined,
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
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.status",
    );
    const statusResult = await gitService.getStatus({
      runId,
      workspaceRoot: worktree,
    });
    const repoIdentity = await gitService.getRepoIdentity({
      workspace: { runId, filesystemRoot: worktree },
    });
    const commitIdentity = await this.readWorkspaceCommitIdentity(
      worktree,
      runId,
      gitService,
    );
    const parsed = this.buildStatusResponse(
      statusResult,
      repoIdentity,
      commitIdentity,
    );

    if (parsed.files.length > 0) {
      const lineCounts = await this.loadFileChangeLineCounts(
        gitService,
        worktree,
        runId,
        parsed.files,
      );
      for (const file of parsed.files) {
        const counts = lineCounts.get(file.path);
        if (counts) {
          file.additions = counts.additions;
          file.deletions = counts.deletions;
        }
      }
    }

    return { success: true, output: JSON.stringify(parsed) };
  }

  private createGitService(
    sandbox: Sandbox,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    operation: string,
  ): DefaultGitService {
    return new DefaultGitService(
      new SandboxGitCommandExecutor(sandbox, toolboxContext, operation),
    );
  }

  private buildStatusResponse(
    status: GitStatusResult,
    repoIdentity: string | null,
    commitIdentity: GitCommitIdentity | null,
  ): GitStatusResponse {
    const files = status.entries.flatMap((entry) =>
      this.toSharedFileStatus(entry),
    );
    return {
      files,
      ahead: status.branch.ahead ?? 0,
      behind: status.branch.behind ?? 0,
      branch: status.branch.head ?? "",
      repoIdentity,
      commitIdentity,
      hasStaged: status.entries.some((entry) => isStatusEntryStaged(entry)),
      hasUnstaged: status.entries.some((entry) => isStatusEntryUnstaged(entry)),
      gitAvailable: true,
    };
  }

  private toSharedFileStatus(entry: GitStatusEntry): FileStatus[] {
    if (this.isInternalStatusEntry(entry.path)) {
      return [];
    }
    return [
      {
        path: entry.path,
        status: toSharedStatus(entry),
        additions: 0,
        deletions: 0,
        isStaged: isStatusEntryStaged(entry),
      },
    ];
  }

  private isInternalStatusEntry(filePath: string): boolean {
    return (
      filePath === PATCH_WORK_DIR ||
      filePath.startsWith(`${PATCH_WORK_DIR}/`) ||
      filePath.includes(`/${PATCH_WORK_DIR}/`)
    );
  }

  private async loadFileChangeLineCounts(
    gitService: DefaultGitService,
    worktree: string,
    runId: string,
    files: FileStatus[],
  ): Promise<Map<string, { additions: number; deletions: number }>> {
    const lineCounts = new Map<
      string,
      { additions: number; deletions: number }
    >();
    const counts = await gitService.getFileLineCounts({
      workspace: { runId, filesystemRoot: worktree },
      paths: files.map((file) => file.path),
    });
    for (const count of counts) {
      lineCounts.set(count.path, toLineCountValue(count));
    }
    return lineCounts;
  }

  private async readWorkspaceCommitIdentity(
    worktree: string,
    runId: string,
    gitService: DefaultGitService,
  ): Promise<GitCommitIdentity | null> {
    const workspace = { runId, filesystemRoot: worktree };
    const authorName = await gitService.readConfigValue({
      workspace,
      key: "user.name",
    });
    const authorEmail = await gitService.readConfigValue({
      workspace,
      key: "user.email",
    });
    if (!authorName || !authorEmail) {
      return null;
    }

    return {
      authorName,
      authorEmail,
      source: "workspace_git_config",
      verified: false,
    };
  }

  private async getDiff(
    sandbox: Sandbox,
    worktree: string,
    filePath: string | undefined,
    staged: boolean | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeFilePath = filePath
      ? validateRepoRelativePath(filePath)
      : undefined;
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.diff",
    );
    const diffResult = await gitService.getDiff({
      workspace: { runId, filesystemRoot: worktree },
      paths: safeFilePath ? [safeFilePath] : [],
      staged: staged === true,
    });

    if (safeFilePath && !staged && diffResult.patch.trim().length === 0) {
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

    const parsedDiff = this.parseDiff(diffResult.patch, filePath);
    return { success: true, output: JSON.stringify(parsedDiff) };
  }

  private async capturePatch(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const status = await this.ensureGitStatusAvailable(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );
    if (!status.success) {
      return status;
    }

    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.patch_capture",
    );
    const result = await gitService.capturePatch({
      workspace: { runId, filesystemRoot: worktree },
      internalPathPrefix: PATCH_WORK_DIR,
    });
    return buildPatchCaptureResult(result);
  }

  private async ensureGitStatusAvailable(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    return this.getStatus(sandbox, worktree, toolboxContext, runId);
  }

  private async createTemporaryPatchPath(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    operation: string,
  ): Promise<string> {
    const patchPath = `${worktree}/${PATCH_WORK_DIR}/edit-artifact-${crypto.randomUUID()}.patch`;
    await this.prepareTemporaryPatchDirectory(
      sandbox,
      worktree,
      toolboxContext,
      runId,
      operation,
    );
    return patchPath;
  }

  private async prepareTemporaryPatchDirectory(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    operation: string,
  ): Promise<void> {
    await this.runToolboxCommand(
      sandbox,
      {
        command: "mkdir",
        args: ["-p", `${worktree}/${PATCH_WORK_DIR}`],
        runId,
      },
      ["mkdir"],
      toolboxContext,
      operation,
    );
  }

  private async readTemporaryPatch(
    sandbox: Sandbox,
    patchPath: string,
  ): Promise<PluginResult> {
    const result = await sandbox.readFile(patchPath, { encoding: "utf-8" });
    if (!result.success) {
      return {
        success: false,
        error: `Failed to read captured patch file: ${patchPath}`,
      };
    }
    return { success: true, output: result.content };
  }

  private async applyPatch(
    sandbox: Sandbox,
    worktree: string,
    patch: string | undefined,
    dryRun: boolean | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const patchPayload = validatePatchPayload(patch);
    if (!patchPayload.success) {
      return { success: false, error: patchPayload.error };
    }

    const patchPath = await this.writeTemporaryPatch(
      sandbox,
      worktree,
      patchPayload.patch,
      toolboxContext,
      runId,
    );
    try {
      const checkResult = await this.checkTemporaryPatch(
        sandbox,
        worktree,
        patchPath,
        toolboxContext,
        runId,
      );
      if (!checkResult.success || dryRun) {
        return checkResult;
      }

      return await this.applyTemporaryPatch(
        sandbox,
        worktree,
        patchPath,
        toolboxContext,
        runId,
      );
    } finally {
      await this.deleteTemporaryPatch(
        sandbox,
        patchPath,
        toolboxContext,
        runId,
      );
    }
  }

  private async writeTemporaryPatch(
    sandbox: Sandbox,
    worktree: string,
    patch: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<string> {
    const patchPath = await this.createTemporaryPatchPath(
      sandbox,
      worktree,
      toolboxContext,
      runId,
      "git.patch_apply.prepare",
    );
    await sandbox.writeFile(patchPath, patch);
    return patchPath;
  }

  private async checkTemporaryPatch(
    sandbox: Sandbox,
    worktree: string,
    patchPath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "apply", "--check", patchPath],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.patch_apply.check",
    );
    return result.exitCode === 0
      ? { success: true, output: "Patch dry-run succeeded" }
      : { success: false, error: result.stderr };
  }

  private async applyTemporaryPatch(
    sandbox: Sandbox,
    worktree: string,
    patchPath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const result = await this.runToolboxCommand(
      sandbox,
      { command: "git", args: ["-C", worktree, "apply", patchPath], runId },
      ["git"],
      toolboxContext,
      "git.patch_apply.apply",
    );
    return result.exitCode === 0
      ? { success: true, output: "Patch applied" }
      : { success: false, error: result.stderr };
  }

  private async deleteTemporaryPatch(
    sandbox: Sandbox,
    patchPath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<void> {
    await this.runToolboxCommand(
      sandbox,
      { command: "rm", args: ["-f", patchPath], runId },
      ["rm"],
      toolboxContext,
      "git.patch_apply.cleanup",
    );
  }

  private async getUntrackedFileDiff(
    sandbox: Sandbox,
    worktree: string,
    safeFilePath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<DiffContent | null> {
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.diff_untracked",
    );
    const diffResult = await gitService.getUntrackedFileDiff({
      workspace: { runId, filesystemRoot: worktree },
      path: safeFilePath,
    });
    return diffResult ? this.parseDiff(diffResult.patch, safeFilePath) : null;
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
    const safeFiles = normalizeExplicitFileList(files);
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.stage",
    );
    await gitService.stageFiles({
      workspace: { runId, filesystemRoot: worktree },
      paths: safeFiles,
    });
    return { success: true, output: "Files staged" };
  }

  private async unstageFiles(
    sandbox: Sandbox,
    worktree: string,
    files: string[] | undefined,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const safeFiles = normalizeExplicitFileList(files);
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.unstage",
    );
    await gitService.unstageFiles({
      workspace: { runId, filesystemRoot: worktree },
      paths: safeFiles,
    });
    return { success: true, output: "Files unstaged" };
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
    const safeFiles = normalizeExplicitFileList(files);

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

    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.commit",
    );
    const result = await gitService.commit({
      workspace: { runId, filesystemRoot: worktree },
      paths: safeFiles,
      message,
      author: {
        name: commitIdentityResult.identity.authorName,
        email: commitIdentityResult.identity.authorEmail,
      },
    });

    return {
      success: true,
      output: {
        content: "Changes committed",
        commitIdentity: {
          source: commitIdentityResult.identity.source,
          verified: commitIdentityResult.identity.verified,
        },
      },
      metadata: {
        commitSha: result.commitSha,
        branchName: result.branchName,
        commitIdentity: commitIdentityResult.identity,
      },
    };
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

      const emailFromList =
        await this.resolvePrimaryEmailFromToken(accessToken);
      const authorEmail =
        directEmail ??
        emailFromList ??
        (login && id !== null
          ? `${id}+${login}@users.noreply.github.com`
          : null);

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
      const emails = await this.fetchGitHubJson<Array<Record<string, unknown>>>(
        token,
        "/user/emails",
      );
      const selected =
        emails.find(
          (entry) =>
            readBooleanValue(entry.primary) && readBooleanValue(entry.verified),
        ) ??
        emails.find((entry) => readBooleanValue(entry.verified)) ??
        emails.find((entry) => readBooleanValue(entry.primary)) ??
        null;
      return selected ? (readStringValue(selected.email) ?? null) : null;
    } catch (error) {
      return null;
    }
  }

  private async fetchGitHubJson<T>(token: string, path: string): Promise<T> {
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
    const gitService = this.createGitService(sandbox, toolboxContext, toolName);
    const value = await gitService.readConfigValue({
      workspace: { runId, filesystemRoot: worktree },
      key,
    });
    return value ?? "";
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
    if (!branch || branch.trim().length === 0) {
      return {
        success: false,
        error: "Working branch is required for git_push",
      };
    }
    const safeBranch = sanitizeRef(branch, "branch");
    const authArgs = this.buildGitAuthArgs(token);
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.push",
    );
    try {
      await gitService.push({
        workspace: {
          runId,
          filesystemRoot: worktree,
          workingBranch: safeBranch,
        },
        remoteName: safeRemote,
        authArgs,
      });
      return { success: true, output: "Changes pushed" };
    } catch (error) {
      const message = getGitServiceErrorMessage(error);
      if (isNonFastForwardGitPushError(message)) {
        return {
          success: false,
          error: buildNonFastForwardPushError(safeRemote, safeBranch),
        };
      }
      return {
        success: false,
        error: message,
      };
    }
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
    const gitService = this.createGitService(sandbox, toolboxContext, "git.pull");
    await gitService.pull({
      workspace: { runId, filesystemRoot: worktree },
      remoteName: safeRemote,
      branchName: branch?.trim() ? sanitizeRef(branch, "branch") : undefined,
      authArgs,
    });
    return { success: true, output: "Changes pulled successfully" };
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
    const gitService = this.createGitService(sandbox, toolboxContext, "git.fetch");
    await gitService.fetch({
      workspace: { runId, filesystemRoot: worktree },
      remoteName: safeRemote,
      authArgs,
    });
    return { success: true, output: "Fetched successfully" };
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
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.branch_create",
    );
    const result = await gitService.createBranch({
      workspace: { runId, filesystemRoot: worktree },
      branchName: safeBranch,
    });
    return { success: true, output: result.message };
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
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.branch_switch",
    );
    const result = await gitService.switchBranch({
      workspace: { runId, filesystemRoot: worktree },
      branchName: safeBranch,
    });
    return { success: true, output: result.message };
  }

  private async listBranches(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const gitService = this.createGitService(
      sandbox,
      toolboxContext,
      "git.branch_list",
    );
    const result = await gitService.listBranches({
      workspace: { runId, filesystemRoot: worktree },
    });
    return { success: true, output: result.output };
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

function toLineCountValue(
  count: GitFileLineCount,
): { additions: number; deletions: number } {
  return {
    additions: count.additions,
    deletions: count.deletions,
  };
}

function normalizeExplicitFileList(files: string[] | undefined): string[] {
  if (!files || files.length === 0) {
    throw new Error("Explicit file paths are required for this git operation");
  }
  return files.map((file) => validateRepoRelativePath(file));
}

function toSharedStatus(entry: GitStatusEntry): FileStatus["status"] {
  switch (entry.status) {
    case "added":
    case "deleted":
    case "renamed":
    case "untracked":
      return entry.status;
    case "copied":
      return "added";
    case "type_changed":
    case "modified":
    case "unmerged":
      return "modified";
  }
}

function isStatusEntryStaged(entry: GitStatusEntry): boolean {
  if (entry.kind === "untracked") {
    return false;
  }
  return entry.xy.index !== ".";
}

function isStatusEntryUnstaged(entry: GitStatusEntry): boolean {
  if (entry.kind === "untracked") {
    return true;
  }
  return entry.xy.worktree !== ".";
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

function containsIllegalTokenChars(token: string): boolean {
  return /[\0\r\n]/.test(token);
}

function isNonFastForwardGitPushError(stderr: string): boolean {
  return /non-fast-forward|tip of your current branch is behind/i.test(stderr);
}

function buildPatchCaptureResult(
  result: GitPatchCaptureResult,
): PluginResult {
  return {
    success: true,
    output: JSON.stringify({
      patch: result.patch,
      baseCommitSha: result.baseCommitSha,
      branch: result.branch,
    }),
  };
}

function validatePatchPayload(
  patch: string | undefined,
): { success: true; patch: string } | { success: false; error: string } {
  if (!patch || patch.trim().length === 0) {
    return { success: false, error: "Patch payload is required" };
  }
  if (patch.length > 5_000_000) {
    return { success: false, error: "Patch payload exceeds maximum size" };
  }
  return { success: true, patch };
}

function buildNonFastForwardPushError(
  remote: string,
  branch: string,
): string {
  return `Push failed because ${remote}/${branch} already has newer commits. Your file changes are already committed locally. Sync the branch with git pull --ff-only and retry the push. If the branch cannot be fast-forwarded, resolve the branch conflict manually before retrying.`;
}

function buildGitResult(
  result: { exitCode: number; stdout: string; stderr: string },
  successMessage: string,
): PluginResult {
  return {
    success: result.exitCode === 0,
    output: result.exitCode === 0 ? successMessage : undefined,
    error:
      result.exitCode === 0 ? undefined : buildGitCommandFailureMessage(result),
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

function getGitServiceErrorMessage(error: unknown): string {
  if (error instanceof GitServiceError) {
    const stderr = error.context.stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Git operation failed";
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
