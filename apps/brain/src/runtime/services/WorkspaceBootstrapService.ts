import type {
  WorkspaceBootstrapMode,
  WorkspaceBootstrapRequest,
  WorkspaceBootstrapResult,
  WorkspaceBootstrapper,
  RepositoryContext,
} from "@shadowbox/execution-engine/runtime";
import { z } from "zod";
import { ExecutionService } from "../../services/ExecutionService";
import type { Env } from "../../types/ai";

type GitAction =
  | "git_status"
  | "git_clone"
  | "git_fetch"
  | "git_branch_switch"
  | "git_branch_create"
  | "git_branch_list"
  | "git_pull";

interface GitPluginResult {
  success: boolean;
  error?: string;
  output?: unknown;
}

interface GitExecutionClient {
  execute(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
}

interface NormalizedRepositoryContext {
  owner: string;
  repo: string;
  branch: string;
  repoIdentity: string;
  baseUrl?: string;
}

interface WorkspaceSyncCacheEntry {
  lastSyncedAt: number;
}

interface BranchAvailability {
  localExists: boolean;
  remoteExists: boolean;
}

const SAFE_REPOSITORY_SEGMENT_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_BRANCH_REGEX = /^[A-Za-z0-9._/-]{1,200}$/;
const DEFAULT_SYNC_TTL_MS = 2 * 60 * 1000;
const CACHE_RETENTION_MULTIPLIER = 10;
const AUTH_FAILURE_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /access denied/i,
  /permission denied/i,
  /denied to/i,
  /repository not found/i,
  /http.*\b(401|403)\b/i,
];
const NOT_GIT_REPOSITORY_PATTERNS = [/not a git repository/i];
const BRANCH_MISSING_PATTERNS = [
  /pathspec .* did not match any file/i,
  /unknown revision or path/i,
];
const REMOTE_REF_MISSING_PATTERNS = [/couldn't find remote ref/i];
const REMOTE_MISSING_PATTERNS = [/no such remote/i];
const NO_TRACKING_PATTERNS = [/there is no tracking information/i];
const CLONE_DESTINATION_NOT_EMPTY_PATTERNS = [
  /destination path .* already exists and is not an empty directory/i,
];
const TRANSIENT_STATUS_FAILURE_PATTERNS = [
  /sandboxerror:\s*http error!\s*status:\s*5\d\d/i,
  /http error!\s*status:\s*5\d\d/i,
  /failed with http 5\d\d/i,
  /service unavailable/i,
  /upstream connect error/i,
  /econnrefused/i,
  /timed out/i,
  /failed to fetch/i,
  /network connection lost/i,
  /couldn't find a local dev session/i,
  /entrypoint of service .* to proxy to/i,
];
const GIT_STATUS_MAX_ATTEMPTS = 3;
const GIT_STATUS_RETRY_DELAY_MS = 250;
const workspaceSyncCache = new Map<string, WorkspaceSyncCacheEntry>();
const bootstrapInFlight = new Map<string, Promise<WorkspaceBootstrapResult>>();
const gitStatusOutputSchema = z.object({
  branch: z.string(),
  files: z.array(z.unknown()),
  repoIdentity: z.string().min(1).nullish(),
  hasStaged: z.boolean(),
  hasUnstaged: z.boolean(),
  gitAvailable: z.boolean(),
});

export class WorkspaceBootstrapService implements WorkspaceBootstrapper {
  constructor(
    private executionClient: GitExecutionClient,
    private syncTtlMs: number = DEFAULT_SYNC_TTL_MS,
  ) {}

  static fromEnv(
    env: Env,
    sessionId: string,
    runId: string,
    userId?: string,
  ): WorkspaceBootstrapService {
    const executionService = new ExecutionService(
      env,
      sessionId,
      runId,
      userId,
    );
    return new WorkspaceBootstrapService(executionService);
  }

  async bootstrap(
    request: WorkspaceBootstrapRequest,
  ): Promise<WorkspaceBootstrapResult> {
    const inFlightKey = buildBootstrapInFlightKey(request);
    const existingRequest = bootstrapInFlight.get(inFlightKey);
    if (existingRequest) {
      return existingRequest;
    }

    const bootstrapRequest = this.bootstrapUncoalesced(request);
    bootstrapInFlight.set(inFlightKey, bootstrapRequest);
    try {
      return await bootstrapRequest;
    } finally {
      if (bootstrapInFlight.get(inFlightKey) === bootstrapRequest) {
        bootstrapInFlight.delete(inFlightKey);
      }
    }
  }

  private async bootstrapUncoalesced(
    request: WorkspaceBootstrapRequest,
  ): Promise<WorkspaceBootstrapResult> {
    const bootstrapStartedAt = Date.now();
    let bootstrapResult: WorkspaceBootstrapResult | null = null;
    const bootstrapMode = request.mode;
    pruneWorkspaceSyncCache(this.syncTtlMs);
    const normalized = normalizeRepositoryContext(request.repositoryContext);
    if (!normalized) {
      bootstrapResult = {
        status: "invalid-context",
        message:
          "Repository context is missing or invalid. Select a repository and branch, then retry.",
        clonedDuringBootstrap: false,
      };
      this.logBootstrapTiming(
        request.runId,
        bootstrapResult,
        bootstrapStartedAt,
      );
      return bootstrapResult;
    }

    const cloneUrl = resolveCloneUrl(normalized);
    if (!cloneUrl) {
      bootstrapResult = {
        status: "invalid-context",
        message:
          "Repository URL is invalid. Re-select the repository and branch, then retry.",
        clonedDuringBootstrap: false,
      };
      this.logBootstrapTiming(
        request.runId,
        bootstrapResult,
        bootstrapStartedAt,
      );
      return bootstrapResult;
    }

    const cacheKey = buildWorkspaceSyncCacheKey(
      request.runId,
      normalized,
      bootstrapMode,
    );
    if (isWorkspaceSyncCacheFresh(cacheKey, this.syncTtlMs)) {
      bootstrapResult = { status: "ready", clonedDuringBootstrap: false };
      this.logBootstrapTiming(
        request.runId,
        bootstrapResult,
        bootstrapStartedAt,
      );
      return bootstrapResult;
    }

    const statusResult = await this.executeGitStatusWithRetry(request.runId);
    if (!statusResult.success) {
      const statusError = statusResult.error ?? "Unable to check git status.";
      if (!matchesAny(statusError, NOT_GIT_REPOSITORY_PATTERNS)) {
        bootstrapResult = mapGitFailure(statusError);
        this.logBootstrapTiming(
          request.runId,
          bootstrapResult,
          bootstrapStartedAt,
        );
        return bootstrapResult;
      }

      const cloneResult = await this.executeGit(
        "git_clone",
        { url: cloneUrl },
        request.runId,
      );
      if (!cloneResult.success) {
        const cloneError =
          cloneResult.error ?? "Failed to clone repository into workspace.";
        if (matchesAny(cloneError, CLONE_DESTINATION_NOT_EMPTY_PATTERNS)) {
          const forcedCloneResult = await this.executeGit(
            "git_clone",
            {
              url: cloneUrl,
              replaceExisting: true,
            },
            request.runId,
          );
          if (forcedCloneResult.success) {
            bootstrapResult = await this.syncBranch(
              cacheKey,
              normalized.branch,
              request.runId,
              bootstrapMode,
              true,
            );
            this.logBootstrapTiming(
              request.runId,
              bootstrapResult,
              bootstrapStartedAt,
            );
            return bootstrapResult;
          }
          bootstrapResult = mapGitFailure(
            forcedCloneResult.error ??
              "Failed to replace existing workspace contents for repository clone.",
          );
          this.logBootstrapTiming(
            request.runId,
            bootstrapResult,
            bootstrapStartedAt,
          );
          return bootstrapResult;
        }
        bootstrapResult = mapGitFailure(cloneError);
        this.logBootstrapTiming(
          request.runId,
          bootstrapResult,
          bootstrapStartedAt,
        );
        return bootstrapResult;
      }

      bootstrapResult = await this.syncBranch(
        cacheKey,
        normalized.branch,
        request.runId,
        bootstrapMode,
        true,
      );
      this.logBootstrapTiming(
        request.runId,
        bootstrapResult,
        bootstrapStartedAt,
      );
      return bootstrapResult;
    }

    const workspaceStatus = parseWorkspaceGitStatus(statusResult.output);
    if (isMatchingWorkspaceStatus(workspaceStatus, normalized)) {
      const hasLocalChanges =
        workspaceStatus.hasStaged ||
        workspaceStatus.hasUnstaged ||
        workspaceStatus.files.length > 0;
      if (hasLocalChanges) {
        setWorkspaceSyncCache(cacheKey);
        bootstrapResult = {
          status: "ready",
          clonedDuringBootstrap: false,
        };
        this.logBootstrapTiming(
          request.runId,
          bootstrapResult,
          bootstrapStartedAt,
        );
        return bootstrapResult;
      }
    }

    if (!workspaceStatus) {
      bootstrapResult = mapGitFailure(
        "Invalid git status response from workspace.",
      );
      this.logBootstrapTiming(
        request.runId,
        bootstrapResult,
        bootstrapStartedAt,
      );
      return bootstrapResult;
    }

    if (workspaceStatus.branch !== normalized.branch) {
      console.log(
        `[workspace/bootstrap] run=${request.runId} branch-mismatch current=${workspaceStatus.branch} target=${normalized.branch}`,
      );
    }

    bootstrapResult = await this.syncBranch(
      cacheKey,
      normalized.branch,
      request.runId,
      bootstrapMode,
      false,
    );
    this.logBootstrapTiming(request.runId, bootstrapResult, bootstrapStartedAt);
    return bootstrapResult;
  }

  private async syncBranch(
    cacheKey: string,
    branch: string,
    runId: string,
    mode: WorkspaceBootstrapMode,
    clonedDuringBootstrap: boolean,
  ): Promise<WorkspaceBootstrapResult> {
    const shouldFetch = mode !== "read_only";
    const shouldPull = mode === "git_write" && !clonedDuringBootstrap;
    let branchExistsOnRemote: boolean | null = null;

    if (shouldFetch) {
      const fetchResult = await this.executeGit(
        "git_fetch",
        { remote: "origin" },
        runId,
      );
      if (!fetchResult.success) {
        const fetchError = fetchResult.error ?? "Failed to fetch from origin.";
        if (!matchesAny(fetchError, REMOTE_MISSING_PATTERNS)) {
          return mapGitFailure(fetchError);
        }
      }
    }

    let switchResult = await this.executeGit(
      "git_branch_switch",
      { branch },
      runId,
    );
    if (
      !switchResult.success &&
      !shouldFetch &&
      matchesAny(
        switchResult.error ?? "Failed to switch branch.",
        BRANCH_MISSING_PATTERNS,
      )
    ) {
      const fetchForMissingBranch = await this.executeGit(
        "git_fetch",
        { remote: "origin" },
        runId,
      );
      if (
        !fetchForMissingBranch.success &&
        !matchesAny(
          fetchForMissingBranch.error ?? "Failed to fetch from origin.",
          REMOTE_MISSING_PATTERNS,
        )
      ) {
        return mapGitFailure(
          fetchForMissingBranch.error ?? "Failed to fetch from origin.",
        );
      }
      switchResult = await this.executeGit(
        "git_branch_switch",
        { branch },
        runId,
      );
    }

    if (!switchResult.success) {
      const switchError = switchResult.error ?? "Failed to switch branch.";
      if (!matchesAny(switchError, BRANCH_MISSING_PATTERNS)) {
        return mapGitFailure(switchError);
      }

      const availability = await this.readBranchAvailability(branch, runId);
      if (availability) {
        branchExistsOnRemote = availability.remoteExists;
      }

      const createResult = await this.executeGit(
        "git_branch_create",
        { branch },
        runId,
      );
      if (!createResult.success) {
        return mapGitFailure(
          createResult.error ?? `Failed to create branch ${branch}.`,
        );
      }
    }

    if (shouldPull) {
      if (branchExistsOnRemote === false) {
        setWorkspaceSyncCache(cacheKey);
        return { status: "ready", clonedDuringBootstrap };
      }
      const pullResult = await this.executeGit(
        "git_pull",
        {
          remote: "origin",
          branch,
        },
        runId,
      );
      if (!pullResult.success) {
        const pullError =
          pullResult.error ?? "Failed to pull latest branch changes.";
        if (
          matchesAny(pullError, REMOTE_REF_MISSING_PATTERNS) ||
          matchesAny(pullError, REMOTE_MISSING_PATTERNS) ||
          matchesAny(pullError, NO_TRACKING_PATTERNS)
        ) {
          setWorkspaceSyncCache(cacheKey);
          return { status: "ready", clonedDuringBootstrap };
        }
        return mapGitFailure(pullError);
      }
    }

    setWorkspaceSyncCache(cacheKey);
    return { status: "ready", clonedDuringBootstrap };
  }

  private async readBranchAvailability(
    branch: string,
    runId: string,
  ): Promise<BranchAvailability | null> {
    const branchListResult = await this.executeGit("git_branch_list", {}, runId);
    if (!branchListResult.success || typeof branchListResult.output !== "string") {
      return null;
    }

    return parseBranchAvailability(branchListResult.output, branch);
  }

  private async executeGit(
    action: GitAction,
    payload: Record<string, unknown>,
    runId: string,
  ): Promise<GitPluginResult> {
    const startedAt = Date.now();
    try {
      const result = await this.executionClient.execute("git", action, payload);
      const parsedResult = toGitPluginResult(result);
      console.log(
        `[workspace/bootstrap/timing] run=${runId} action=${action} success=${parsedResult.success} elapsedMs=${Date.now() - startedAt}`,
      );
      return parsedResult;
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Workspace git execution failed.";
      console.log(
        `[workspace/bootstrap/timing] run=${runId} action=${action} success=false elapsedMs=${Date.now() - startedAt} error=${errorMessage}`,
      );
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async executeGitStatusWithRetry(runId: string): Promise<GitPluginResult> {
    let attempt = 1;
    let statusResult = await this.executeGit("git_status", {}, runId);
    while (
      attempt < GIT_STATUS_MAX_ATTEMPTS &&
      isRetryableGitStatusFailure(statusResult.error)
    ) {
      const nextAttempt = attempt + 1;
      const delayMs = GIT_STATUS_RETRY_DELAY_MS * attempt;
      console.warn(
        `[workspace/bootstrap] run=${runId} retrying git_status after transient failure (attempt ${nextAttempt}/${GIT_STATUS_MAX_ATTEMPTS})`,
      );
      await sleep(delayMs);
      statusResult = await this.executeGit("git_status", {}, runId);
      attempt = nextAttempt;
    }

    return statusResult;
  }

  private logBootstrapTiming(
    runId: string,
    result: WorkspaceBootstrapResult,
    startedAt: number,
  ): void {
    console.log(
      `[workspace/bootstrap/timing] run=${runId} status=${result.status} elapsedMs=${Date.now() - startedAt}`,
    );
  }
}

function buildBootstrapInFlightKey(request: WorkspaceBootstrapRequest): string {
  const runId = request.runId.trim();
  const context = request.repositoryContext;
  const owner = context.owner?.trim() ?? "";
  const repo = context.repo?.trim() ?? "";
  const branch = context.branch?.trim() ?? "";
  const baseUrl = context.baseUrl?.trim() ?? "";
  return [runId, owner, repo, branch, baseUrl, request.mode].join(":");
}

function buildWorkspaceSyncCacheKey(
  runId: string,
  context: NormalizedRepositoryContext,
  mode: WorkspaceBootstrapMode,
): string {
  return [
    runId,
    context.repoIdentity,
    context.branch,
    mode,
    context.baseUrl ?? "",
  ].join(":");
}

function isWorkspaceSyncCacheFresh(cacheKey: string, ttlMs: number): boolean {
  const cached = workspaceSyncCache.get(cacheKey);
  if (!cached) {
    return false;
  }
  return Date.now() - cached.lastSyncedAt < ttlMs;
}

function setWorkspaceSyncCache(cacheKey: string): void {
  workspaceSyncCache.set(cacheKey, { lastSyncedAt: Date.now() });
}

function pruneWorkspaceSyncCache(ttlMs: number): void {
  const maxAgeMs = ttlMs * CACHE_RETENTION_MULTIPLIER;
  const now = Date.now();
  for (const [key, entry] of workspaceSyncCache.entries()) {
    if (now - entry.lastSyncedAt > maxAgeMs) {
      workspaceSyncCache.delete(key);
    }
  }
}

function toGitPluginResult(result: unknown): GitPluginResult {
  if (!result || typeof result !== "object") {
    return {
      success: false,
      error: "Unexpected git plugin response.",
    };
  }

  const candidate = result as {
    success?: unknown;
    error?: unknown;
    output?: unknown;
  };
  if (typeof candidate.success !== "boolean") {
    return {
      success: false,
      error: "Invalid git plugin response shape.",
    };
  }

  return {
    success: candidate.success,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    output: candidate.output,
  };
}

function parseWorkspaceGitStatus(
  output: unknown,
): z.infer<typeof gitStatusOutputSchema> | null {
  if (typeof output !== "string" || output.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    const result = gitStatusOutputSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(
        "[workspace/bootstrap] Invalid git status payload",
        result.error.flatten(),
      );
      return null;
    }
    return result.data;
  } catch (error) {
    console.warn(
      "[workspace/bootstrap] Failed to parse git status payload",
      error,
    );
    return null;
  }
}

function mapGitFailure(error: string): WorkspaceBootstrapResult {
  if (matchesAny(error, AUTH_FAILURE_PATTERNS)) {
    return {
      status: "needs-auth",
      message:
        "GitHub authorization is required to access this repository. Reconnect GitHub and retry.",
      clonedDuringBootstrap: false,
    };
  }

  return {
    status: "sync-failed",
    message: sanitizeError(error),
    clonedDuringBootstrap: false,
  };
}

function isRetryableGitStatusFailure(error: string | undefined): boolean {
  if (!error) {
    return false;
  }
  return matchesAny(error, TRANSIENT_STATUS_FAILURE_PATTERNS);
}

async function sleep(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function normalizeRepositoryContext(
  repositoryContext: RepositoryContext,
): NormalizedRepositoryContext | null {
  const owner = repositoryContext.owner?.trim() ?? "";
  const repo = repositoryContext.repo?.trim() ?? "";
  const branch = repositoryContext.branch?.trim() || "main";
  const baseUrl = repositoryContext.baseUrl?.trim();

  if (
    !SAFE_REPOSITORY_SEGMENT_REGEX.test(owner) ||
    !SAFE_REPOSITORY_SEGMENT_REGEX.test(repo) ||
    !SAFE_BRANCH_REGEX.test(branch)
  ) {
    return null;
  }

  return {
    owner,
    repo,
    branch,
    repoIdentity: buildRepoIdentity(owner, repo, baseUrl),
    baseUrl: baseUrl || undefined,
  };
}

function buildRepoIdentity(
  owner: string,
  repo: string,
  baseUrl?: string,
): string {
  const defaultHost = "github.com";
  if (!baseUrl) {
    return `${defaultHost}/${owner}/${repo}`.toLowerCase();
  }

  try {
    const parsed = new URL(baseUrl);
    return `${parsed.host}/${owner}/${repo}`.toLowerCase();
  } catch {
    return `${defaultHost}/${owner}/${repo}`.toLowerCase();
  }
}

function isMatchingWorkspaceStatus(
  workspaceStatus: z.infer<typeof gitStatusOutputSchema> | null,
  normalized: NormalizedRepositoryContext,
): workspaceStatus is z.infer<typeof gitStatusOutputSchema> {
  if (!workspaceStatus) {
    return false;
  }

  return (
    workspaceStatus.branch === normalized.branch &&
    workspaceStatus.repoIdentity === normalized.repoIdentity
  );
}

function resolveCloneUrl(context: NormalizedRepositoryContext): string | null {
  if (!context.baseUrl) {
    return `https://github.com/${context.owner}/${context.repo}.git`;
  }

  try {
    const parsed = new URL(context.baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }

    const cleanedPath = parsed.pathname
      .replace(/\/+$/g, "")
      .replace(/\.git$/i, "");

    if (!cleanedPath || cleanedPath === "/") {
      return null;
    }

    return `${parsed.origin}${cleanedPath}.git`;
  } catch {
    return null;
  }
}

function sanitizeError(error: string): string {
  const trimmed = error.trim();
  if (matchesAny(trimmed, CLONE_DESTINATION_NOT_EMPTY_PATTERNS)) {
    return "Workspace initialization conflict: existing non-repository files blocked clone. Retry to reinitialize the workspace.";
  }
  if (matchesAny(trimmed, TRANSIENT_STATUS_FAILURE_PATTERNS)) {
    return "Git service is temporarily unavailable. Please retry in a few seconds.";
  }
  return trimmed.length > 0
    ? trimmed
    : "Workspace synchronization failed due to an unknown git error.";
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function parseBranchAvailability(
  rawBranchList: string,
  targetBranch: string,
): BranchAvailability {
  const normalizedTarget = targetBranch.trim();
  const localCandidates = new Set<string>();
  const remoteCandidates = new Set<string>();

  rawBranchList
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s*/, ""))
    .filter(Boolean)
    .forEach((entry) => {
      if (entry.includes(" -> ")) {
        return;
      }
      if (entry.startsWith("remotes/")) {
        const [, remoteName, ...rest] = entry.split("/");
        if (!remoteName || rest.length === 0) {
          return;
        }
        const branchName = rest.join("/");
        remoteCandidates.add(branchName);
        return;
      }
      localCandidates.add(entry);
    });

  return {
    localExists: localCandidates.has(normalizedTarget),
    remoteExists: remoteCandidates.has(normalizedTarget),
  };
}
