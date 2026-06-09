import { Sandbox } from "@cloudflare/sandbox";
import {
  DefaultGitService,
  GitServiceError,
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
  resolveWorkspacePath,
  validateRepoRelativePath,
} from "./security/PathGuard";
import { runSafeCommand } from "./security/SafeCommand";
import {
  readToolboxCommandContext,
  withToolboxCommandContext,
} from "./security/ToolboxCommandContext";
import { SandboxGitCommandExecutor } from "./git/SandboxGitCommandExecutor";

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
  "git_patch_capture",
  "git_patch_apply",
  "git_config",
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
const BRANCH_PATHSPEC_MISSING_PATTERN =
  /pathspec .* did not match any file(?:\(s\))? known to git/i;
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
        case "status":
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
    const parsed = this.buildStatusResponse(
      statusResult,
      repoIdentity,
      commitIdentity,
    );

    if (parsed.files.length > 0) {
      const lineCounts = await this.loadFileChangeLineCounts(
        sandbox,
        worktree,
        toolboxContext,
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
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
    files: FileStatus[],
  ): Promise<Map<string, { additions: number; deletions: number }>> {
    const lineCounts = new Map<
      string,
      { additions: number; deletions: number }
    >();

    const numstatResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "diff", "--numstat"],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.status.numstat",
    );

    if (numstatResult.exitCode === 0) {
      this.mergeNumstatIntoMap(numstatResult.stdout, lineCounts);
    }

    const cachedNumstatResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "diff", "--cached", "--numstat"],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.status.cached_numstat",
    );

    if (cachedNumstatResult.exitCode === 0) {
      this.mergeNumstatIntoMap(cachedNumstatResult.stdout, lineCounts);
    }

    const untrackedFiles = files.filter((file) => file.status === "untracked");
    for (const untracked of untrackedFiles) {
      if (lineCounts.has(untracked.path)) {
        continue;
      }

      const wcResult = await this.runToolboxCommand(
        sandbox,
        {
          command: "wc",
          args: ["-l", "--", `${worktree}/${untracked.path}`],
          runId,
        },
        ["wc"],
        toolboxContext,
        "git.status.wc",
      );

      if (wcResult.exitCode === 0) {
        const match = wcResult.stdout.trim().match(/^(\d+)/);
        if (match && match[1]) {
          const lineCount = Number.parseInt(match[1], 10);
          lineCounts.set(untracked.path, {
            additions: lineCount,
            deletions: 0,
          });
        }
      }
    }

    return lineCounts;
  }

  private mergeNumstatIntoMap(
    stdout: string,
    map: Map<string, { additions: number; deletions: number }>,
  ): void {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parts = trimmed.split("\t");
      if (parts.length < 3) {
        continue;
      }

      const additions = Number.parseInt(parts[0] ?? "0", 10);
      const deletions = Number.parseInt(parts[1] ?? "0", 10);
      const filePath = parts.slice(2).join("\t");

      if (Number.isNaN(additions) || Number.isNaN(deletions) || !filePath) {
        continue;
      }

      const existing = map.get(filePath);
      if (existing) {
        map.set(filePath, {
          additions: existing.additions + additions,
          deletions: existing.deletions + deletions,
        });
      } else {
        map.set(filePath, { additions, deletions });
      }
    }
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

    const trackedPatch = await this.captureTrackedPatch(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );
    if (!trackedPatch.success) {
      return trackedPatch;
    }

    const untrackedPatch = await this.captureUntrackedPatch(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );
    if (!untrackedPatch.success) {
      return untrackedPatch;
    }

    const metadata = await this.capturePatchMetadata(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );

    return buildPatchCaptureResult(
      getPatchOutput(trackedPatch),
      getPatchOutput(untrackedPatch),
      metadata,
    );
  }

  private async ensureGitStatusAvailable(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    return this.getStatus(sandbox, worktree, toolboxContext, runId);
  }

  private async captureTrackedPatch(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const patchPath = await this.createTemporaryPatchPath(
      sandbox,
      worktree,
      toolboxContext,
      runId,
      "git.patch_capture.prepare",
    );
    try {
      const diffResult = await this.runToolboxCommand(
        sandbox,
        {
          command: "git",
          args: [
            "-C",
            worktree,
            "diff",
            "--binary",
            "--no-ext-diff",
            "--find-renames",
            `--output=${patchPath}`,
          ],
          runId,
        },
        ["git"],
        toolboxContext,
        "git.patch_capture.diff",
      );
      if (diffResult.exitCode !== 0) {
        return { success: false, error: diffResult.stderr };
      }

      return await this.readTemporaryPatch(sandbox, patchPath);
    } finally {
      await this.deleteTemporaryPatch(
        sandbox,
        patchPath,
        toolboxContext,
        runId,
      );
    }
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

  private async captureUntrackedFilePatch(
    sandbox: Sandbox,
    worktree: string,
    safePath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const patchPath = await this.createTemporaryPatchPath(
      sandbox,
      worktree,
      toolboxContext,
      runId,
      "git.patch_capture.untracked_prepare",
    );
    try {
      const diffResult = await this.runToolboxCommand(
        sandbox,
        {
          command: "git",
          args: [
            "diff",
            "--binary",
            "--no-index",
            `--output=${patchPath}`,
            "--",
            "/dev/null",
            safePath,
          ],
          cwd: worktree,
          runId,
        },
        ["git"],
        toolboxContext,
        "git.patch_capture.untracked_diff",
      );
      if (diffResult.exitCode !== 0 && diffResult.exitCode !== 1) {
        return { success: false, error: diffResult.stderr };
      }

      return await this.readTemporaryPatch(sandbox, patchPath);
    } finally {
      await this.deleteTemporaryPatch(
        sandbox,
        patchPath,
        toolboxContext,
        runId,
      );
    }
  }

  private isInternalPatchFile(safePath: string): boolean {
    return (
      safePath === PATCH_WORK_DIR || safePath.startsWith(`${PATCH_WORK_DIR}/`)
    );
  }

  private async captureUntrackedPatch(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<PluginResult> {
    const diffResult = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: [
          "-C",
          worktree,
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
        ],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.patch_capture.untracked_list",
    );
    if (diffResult.exitCode !== 0) {
      return { success: false, error: diffResult.stderr };
    }

    const patches: string[] = [];
    for (const filePath of splitNullTerminatedPaths(diffResult.stdout)) {
      const safePath = validateRepoRelativePath(filePath);
      if (this.isInternalPatchFile(safePath)) {
        continue;
      }

      const patch = await this.captureUntrackedFilePatch(
        sandbox,
        worktree,
        safePath,
        toolboxContext,
        runId,
      );
      if (!patch.success) {
        return patch;
      }

      const output = getPatchOutput(patch);
      if (hasPatchContent(output)) {
        patches.push(output);
      }
    }

    return { success: true, output: patches.join("\n") };
  }

  private async capturePatchMetadata(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<{ baseCommitSha: string | null; branch: string | null }> {
    const baseCommitSha = await this.readHeadCommitSha(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );
    const branch = await this.readCurrentBranch(
      sandbox,
      worktree,
      toolboxContext,
      runId,
    );

    return { baseCommitSha, branch };
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

  private async readHeadCommitSha(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<string | null> {
    const result = await this.runToolboxCommand(
      sandbox,
      { command: "git", args: ["-C", worktree, "rev-parse", "HEAD"], runId },
      ["git"],
      toolboxContext,
      "git.patch_capture.head",
    );
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  private async readCurrentBranch(
    sandbox: Sandbox,
    worktree: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<string | null> {
    const result = await this.runToolboxCommand(
      sandbox,
      {
        command: "git",
        args: ["-C", worktree, "branch", "--show-current"],
        runId,
      },
      ["git"],
      toolboxContext,
      "git.patch_capture.branch",
    );
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
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
    const isUntracked = await this.isFileUntracked(
      sandbox,
      worktree,
      safeFilePath,
      toolboxContext,
      runId,
    );
    if (!isUntracked) {
      return null;
    }

    const fileContent = await this.readUntrackedFileContent(
      sandbox,
      worktree,
      safeFilePath,
      toolboxContext,
      runId,
    );
    return createUntrackedFileDiff(safeFilePath, fileContent);
  }

  private async isFileUntracked(
    sandbox: Sandbox,
    worktree: string,
    safeFilePath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<boolean> {
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
    if (untrackedResult.exitCode !== 0) {
      return false;
    }
    return untrackedResult.stdout
      .split("\n")
      .some((path) => path.trim() === safeFilePath);
  }

  private async readUntrackedFileContent(
    sandbox: Sandbox,
    worktree: string,
    safeFilePath: string,
    toolboxContext: ReturnType<typeof readToolboxCommandContext>,
    runId: string,
  ): Promise<string> {
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
      throw new Error(
        fileResult.stderr.trim() ||
          `Failed to read untracked file: ${safeFilePath}`,
      );
    }
    return fileResult.stdout;
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

function createUntrackedFileDiff(
  filePath: string,
  content: string,
): DiffContent {
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

function getPatchOutput(result: PluginResult): string {
  return typeof result.output === "string" ? result.output : "";
}

function buildPatchCaptureResult(
  trackedPatch: string,
  untrackedPatch: string,
  metadata: { baseCommitSha: string | null; branch: string | null },
): PluginResult {
  return {
    success: true,
    output: JSON.stringify({
      patch: combinePatchParts(trackedPatch, untrackedPatch),
      baseCommitSha: metadata.baseCommitSha,
      branch: metadata.branch,
    }),
  };
}

function combinePatchParts(...parts: string[]): string {
  return parts.filter(hasPatchContent).join("\n");
}

function hasPatchContent(patch: string): boolean {
  return /\S/u.test(patch);
}

function splitNullTerminatedPaths(output: string): string[] {
  return output.split("\0").filter((filePath) => filePath.length > 0);
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
