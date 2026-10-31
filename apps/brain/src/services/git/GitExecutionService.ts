import { decryptToken } from "@legioncode/github-bridge";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import type {
  DiffContent,
  GitBranchMutationResult,
  GitMutationErrorMetadata,
  GitPullRequestMutationResult,
  GitPushMutationResult,
  GitStatusResponse,
} from "@repo/shared-types";
import { sanitizeUnknownError } from "../../core/security/LogSanitizer";
import {
  logErrorRateLimited,
  logWarnRateLimited,
} from "../../lib/rate-limited-log";
import { toCanonicalGitExecutionAction } from "../../lib/gitExecutionActions";
import {
  GIT_MUTATION_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
} from "../gitExecutionTimeouts";
import {
  CommitIdentityError,
  resolveCommitIdentityForCommit,
} from "./GitCommitIdentityService";
import {
  getAuthenticatedUserSession,
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../AuthService";
import type { Env } from "../../types/ai";
import type { SecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import type { SecureExecutionSessionHandle } from "../secure-execution/SecureExecutionSessionClient";

export type GitStatusParams = Extract<AppServerRequest, { method: "git/status" }>['params'];
export type GitDiffParams = Extract<AppServerRequest, { method: "git/diff" }>['params'];
export type GitStageParams = Extract<AppServerRequest, { method: "git/stage" }>['params'];
export type GitCommitParams = Extract<AppServerRequest, { method: "git/commit" }>['params'];
export type GitBranchParams = Extract<AppServerRequest, { method: "git/branch" }>['params'];
export type GitPushParams = Extract<AppServerRequest, { method: "git/push" }>['params'];
export type GitPullRequestParams = Extract<AppServerRequest, { method: "git/pullRequest" }>['params'];

export interface OwnedGitExecution {
  readonly runId: string;
  readonly brainSessionId: string;
  readonly workspaceScope: SecureExecutionWorkspaceScope;
  readonly session: SecureExecutionSessionHandle;
}

export type GitOperationName =
  | "getStatus"
  | "getDiff"
  | "stageFiles"
  | "commit"
  | "createBranch"
  | "push"
  | "createPullRequest";

export class GitExecutionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly metadata?: GitMutationErrorMetadata,
  ) {
    super(message);
    this.name = "GitExecutionError";
  }
}

class GitCheckoutUnavailableError extends Error {
  constructor() {
    super("The original task checkout is unavailable for current Git operations.");
    this.name = "GitCheckoutUnavailableError";
  }
}

interface CanonicalExecutionResponse {
  taskId: string;
  status: "success" | "failure" | "timeout" | "cancelled" | "sandbox_unavailable";
  output?: string;
  error?: { code: string; message: string; details?: unknown };
}

type GitAction =
  | "status"
  | "diff"
  | "stage"
  | "unstage"
  | "commit"
  | "push"
  | "git_fetch"
  | "git_branch_create"
  | "git_branch_switch";

interface PluginSuccessPayload { success: true; output?: unknown }
interface PluginErrorPayload { success: false; error?: string }
type PluginPayload = PluginSuccessPayload | PluginErrorPayload;

const ERROR_LOG_WINDOW_MS = 30_000;
const GIT_STATUS_MAX_ATTEMPTS = 3;
const GIT_STATUS_RETRY_DELAY_MS = 250;
type SecureApiFetch = Env["SECURE_API"]["fetch"];
type SecureApiResponse = Awaited<ReturnType<SecureApiFetch>>;
type SecureApiRequestInit = Parameters<SecureApiFetch>[1];

/** Executes the existing GitPlugin contract against one already-owned checkout. */
export class GitExecutionService {
  constructor(
    private readonly env: Env,
    private readonly execution: OwnedGitExecution,
  ) {}

  async status(_params: GitStatusParams): Promise<GitStatusResponse> {
    return await this.run("getStatus", async () => {
      try {
        return await getCurrentGitStatus(this.env, this.execution);
      } catch (error) {
        if (error instanceof Error && isNotGitRepositoryMessage(error.message)) {
          return getRecoverableNotGitStatus();
        }
        throw error;
      }
    });
  }

  async diff(params: GitDiffParams): Promise<DiffContent> {
    return await this.run("getDiff", async () => {
      try {
        const payload = await executeGitViaCanonicalApi(
          this.env,
          this.execution,
          "diff",
          { path: params.path, staged: params.staged ?? false },
          GIT_MUTATION_TIMEOUT_MS,
        );
        return parseGitPayload<DiffContent>(payload, "diff");
      } catch (error) {
        if (error instanceof Error && isNotGitRepositoryMessage(error.message)) {
          return getEmptyDiff();
        }
        throw error;
      }
    });
  }

  async stage(params: GitStageParams): Promise<{ success: true }> {
    return await this.run("stageFiles", async () => {
      const payload = await executeGitViaCanonicalApi(
        this.env,
        this.execution,
        params.unstage ? "unstage" : "stage",
        { files: params.files },
        GIT_MUTATION_TIMEOUT_MS,
      );
      assertPluginResultSuccess(payload, params.unstage ? "unstage" : "stage");
      return { success: true };
    });
  }

  async commit(request: Request, params: GitCommitParams): Promise<{ success: true }> {
    return await this.run("commit", async () => {
      const authenticatedSession = await getAuthenticatedUserSession(request, this.env);
      const commitIdentity = await resolveCommitIdentityForCommit(
        this.env,
        authenticatedSession,
        params.payload,
      );
      const payload = await executeGitViaCanonicalApi(
        this.env,
        this.execution,
        "commit",
        {
          message: params.payload.message,
          files: params.payload.files,
          authorName: commitIdentity?.authorName,
          authorEmail: commitIdentity?.authorEmail,
        },
        GIT_MUTATION_TIMEOUT_MS,
      );
      assertPluginResultSuccess(payload, "commit");
      return { success: true };
    });
  }

  async branch(params: GitBranchParams): Promise<GitBranchMutationResult> {
    return await this.run("createBranch", async () => {
      const branch = params.payload.branch.trim();
      const currentBranch = await getCurrentGitBranch(this.env, this.execution);
      if (currentBranch === branch) return { success: true, branch: currentBranch };
      await ensureLocalBranch(this.env, this.execution, branch);
      return { success: true, branch: await getCurrentGitBranch(this.env, this.execution) };
    });
  }

  async push(request: Request, params: GitPushParams): Promise<GitPushMutationResult> {
    return await this.run("push", async () => {
      const authenticatedSession = await getAuthenticatedUserSession(request, this.env);
      if (!authenticatedSession) {
        throw new GitExecutionError(
          401,
          "PUSH_FAILED",
          "Authenticate with GitHub before pushing this branch.",
          false,
        );
      }
      const accessToken = await decryptToken(
        authenticatedSession.session.encryptedToken,
        this.env.GITHUB_TOKEN_ENCRYPTION_KEY,
      );
      const branch = params.payload.branch.trim();
      const remote = params.payload.remote?.trim() || "origin";
      const payload = await executeGitViaCanonicalApi(
        this.env,
        this.execution,
        "push",
        { remote, branch, token: accessToken },
        GIT_MUTATION_TIMEOUT_MS,
      );
      assertPluginResultSuccess(payload, "push");
      return { success: true, branch, remote };
    });
  }

  async pullRequest(
    request: Request,
    params: GitPullRequestParams,
  ): Promise<GitPullRequestMutationResult> {
    return await this.run("createPullRequest", async () => {
      const githubAuth = await getGitHubClient(request, this.env);
      if (!githubAuth) {
        throw new GitExecutionError(
          401,
          "PR_CREATION_FAILED",
          "Authenticate with GitHub before creating a pull request.",
          false,
        );
      }
      const status = await getCurrentGitStatus(this.env, this.execution);
      assertPullRequestWorkspaceBinding(status, params.payload.owner, params.payload.repo);
      const head = status.branch.trim();
      if (!head) throw new Error("Git status did not return an active branch for pull request creation");
      const base = params.payload.base?.trim() ||
        (await githubAuth.client.getRepository(params.payload.owner, params.payload.repo)).default_branch;
      const pullRequest = await githubAuth.client.createPullRequest(
        params.payload.owner,
        params.payload.repo,
        {
          title: params.payload.title.trim(),
          body: params.payload.body?.trim() || undefined,
          head,
          base,
        },
      );
      return {
        success: true,
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.html_url,
          state: pullRequest.state,
          head: pullRequest.head.ref,
          base: pullRequest.base.ref,
        },
      };
    });
  }

  private async run<T>(operation: GitOperationName, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const mapped = error instanceof GitExecutionError ? error : mapGitExecutionError(error, operation);
      const message = `[GitExecutionService:${operation}] ${mapped.code}: ${mapped.message}`;
      const key = `GitExecutionService:${operation}:${mapped.code}:${mapped.message}`;
      if (mapped.retryable) {
        logWarnRateLimited(key, message, { error: sanitizeUnknownError(error) }, ERROR_LOG_WINDOW_MS);
      } else {
        logErrorRateLimited(key, message, sanitizeUnknownError(error), ERROR_LOG_WINDOW_MS);
      }
      throw mapped;
    }
  }
}

async function executeGitViaCanonicalApi(
  env: Env,
  execution: OwnedGitExecution,
  action: GitAction,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<PluginPayload> {
  const response = await fetchSecureApiWithTimeout(
    env.SECURE_API,
    buildSecureApiUrl(execution.brainSessionId, "/api/v1/execute"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${execution.session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: execution.session.sessionId,
        taskId: createGitTaskId(action),
        action: "git.execute",
        borrowedLease: {
          leaseId: execution.session.lease.leaseId,
          sandboxId: execution.session.lease.sandboxId,
          generation: execution.session.lease.generation,
        },
        params: {
          action: toCanonicalGitExecutionAction(action),
          ...payload,
          runId: execution.runId,
          workspaceScope: execution.workspaceScope,
        },
        timeout: timeoutMs,
      }),
    },
    timeoutMs,
  );
  await assertSecureApiResponseOk(response, action);
  return normalizeCanonicalGitResponse(parseCanonicalExecutionResponse(await response.json()));
}

async function getCurrentGitStatus(
  env: Env,
  execution: OwnedGitExecution,
): Promise<GitStatusResponse> {
  const payload = await executeGitStatusViaCanonicalApiWithRetry(env, execution);
  return parseGitPayload<GitStatusResponse>(payload, "status");
}

async function executeGitStatusViaCanonicalApiWithRetry(
  env: Env,
  execution: OwnedGitExecution,
): Promise<PluginPayload> {
  for (let attempt = 1; attempt <= GIT_STATUS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = await executeGitViaCanonicalApi(env, execution, "status", {}, GIT_STATUS_TIMEOUT_MS);
      if (attempt < GIT_STATUS_MAX_ATTEMPTS && shouldRetryGitStatusPayload(payload)) {
        logWarnRateLimited(
          `GitExecutionService:status:retry-payload:${execution.runId}`,
          `[GitExecutionService:status] Retrying transient git status plugin failure (attempt ${attempt + 1}/${GIT_STATUS_MAX_ATTEMPTS})`,
          undefined,
          ERROR_LOG_WINDOW_MS,
        );
        await sleep(GIT_STATUS_RETRY_DELAY_MS * attempt);
        continue;
      }
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= GIT_STATUS_MAX_ATTEMPTS || !isTransientGitServiceError(message) || isGitExecutionContractError(message)) {
        throw error;
      }
      logWarnRateLimited(
        `GitExecutionService:status:retry-throw:${execution.runId}`,
        `[GitExecutionService:status] Retrying transient git status error (attempt ${attempt + 1}/${GIT_STATUS_MAX_ATTEMPTS})`,
        { error: sanitizeUnknownError(error) },
        ERROR_LOG_WINDOW_MS,
      );
      await sleep(GIT_STATUS_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error("Git status retry loop terminated unexpectedly.");
}

async function getCurrentGitBranch(env: Env, execution: OwnedGitExecution): Promise<string> {
  const branch = (await getCurrentGitStatus(env, execution)).branch.trim();
  if (!branch) throw new Error("Git status did not return an active branch");
  return branch;
}

async function ensureLocalBranch(
  env: Env,
  execution: OwnedGitExecution,
  branch: string,
): Promise<void> {
  const switchPayload = await executeGitViaCanonicalApi(env, execution, "git_branch_switch", { branch }, GIT_MUTATION_TIMEOUT_MS);
  if (!isPluginErrorPayload(switchPayload)) return;
  const switchError = readPluginErrorMessage(switchPayload);
  if (!isMissingBranchMessage(switchError)) throw new Error(`Git createBranch failed: ${switchError}`);
  try {
    await executeGitViaCanonicalApi(env, execution, "git_fetch", { remote: "origin" }, GIT_MUTATION_TIMEOUT_MS);
  } catch {
    // Non-fatal: preserve the existing switch/create sequence after fetch failures.
  }
  const retrySwitchPayload = await executeGitViaCanonicalApi(env, execution, "git_branch_switch", { branch }, GIT_MUTATION_TIMEOUT_MS);
  if (!isPluginErrorPayload(retrySwitchPayload)) return;
  const createPayload = await executeGitViaCanonicalApi(env, execution, "git_branch_create", { branch }, GIT_MUTATION_TIMEOUT_MS);
  assertPluginResultSuccess(createPayload, "createBranch");
}

function buildSecureApiUrl(sessionNamespace: string, pathname: string): string {
  const url = new URL(pathname, "http://internal/");
  url.searchParams.set("session", sessionNamespace);
  return url.toString();
}

function parseCanonicalExecutionResponse(payload: unknown): CanonicalExecutionResponse {
  if (!payload || typeof payload !== "object") throw new Error("Git execution returned an invalid response payload");
  const candidate = payload as { taskId?: unknown; status?: unknown; output?: unknown; error?: unknown };
  if (
    typeof candidate.taskId !== "string" ||
    (candidate.status !== "success" && candidate.status !== "failure" && candidate.status !== "timeout" && candidate.status !== "cancelled" && candidate.status !== "sandbox_unavailable")
  ) throw new Error("Git execution returned an invalid canonical response");
  return {
    taskId: candidate.taskId,
    status: candidate.status,
    output: typeof candidate.output === "string" ? candidate.output : undefined,
    error: parseCanonicalExecutionError(candidate.error),
  };
}

function parseCanonicalExecutionError(payload: unknown): CanonicalExecutionResponse["error"] {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = payload as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return undefined;
  return { code: candidate.code, message: candidate.message, details: candidate.details };
}

function normalizeCanonicalGitResponse(payload: CanonicalExecutionResponse): PluginPayload {
  if (payload.status === "sandbox_unavailable") throw new GitCheckoutUnavailableError();
  if (payload.status === "success") return { success: true, output: payload.output };
  return { success: false, error: payload.error?.message ?? `Git task ended with status '${payload.status}'` };
}

function createGitTaskId(action: GitAction): string {
  return `git-${action.replace(/_/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPluginErrorPayload(payload: unknown): payload is PluginErrorPayload {
  return !!payload && typeof payload === "object" && "success" in payload && (payload as PluginErrorPayload).success === false;
}

function shouldRetryGitStatusPayload(payload: PluginPayload): boolean {
  if (!isPluginErrorPayload(payload)) return false;
  const message = readPluginErrorMessage(payload);
  return isTransientGitServiceError(message) && !isGitExecutionContractError(message);
}

function readPluginErrorMessage(payload: PluginErrorPayload): string {
  return typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "unknown plugin error";
}

function parseGitPayload<T>(payload: unknown, operation: "status" | "diff"): T {
  if (payload && typeof payload === "object" && "success" in payload) {
    const pluginPayload = payload as PluginPayload;
    if (!pluginPayload.success) {
      const details = readPluginErrorMessage(pluginPayload);
      if (operation === "status" && isNotGitRepositoryMessage(details)) return getRecoverableNotGitStatus() as T;
      if (operation === "diff" && isNotGitRepositoryMessage(details)) return getEmptyDiff() as T;
      throw new Error(`Git ${operation} failed: ${details}`);
    }
    if (pluginPayload.output === undefined) throw new Error(`Git ${operation} returned no output payload`);
    return parseGitOutput<T>(pluginPayload.output, operation);
  }
  return payload as T;
}

function parseGitOutput<T>(output: unknown, operation: "status" | "diff"): T {
  if (typeof output === "string") {
    try { return JSON.parse(output) as T; } catch { throw new Error(`Git ${operation} returned invalid JSON output`); }
  }
  if (output && typeof output === "object") return output as T;
  throw new Error(`Git ${operation} returned unsupported output format`);
}

function isNotGitRepositoryMessage(message: string): boolean { return /not a git repository/i.test(message); }
function isMissingBranchMessage(message: string): boolean {
  return /pathspec .* did not match any file/i.test(message) || /invalid reference/i.test(message) || /not a valid object name/i.test(message) || /unknown revision or path/i.test(message);
}

function assertPullRequestWorkspaceBinding(
  status: GitStatusResponse,
  owner: string,
  repo: string,
): void {
  if (!status.gitAvailable) throw new Error("Git workspace is not ready for pull request creation");
  if (!status.repoIdentity || status.repoIdentity !== `github.com/${owner}/${repo}`.toLowerCase()) {
    throw new Error("Workspace repository binding does not match the selected GitHub repository for this pull request");
  }
}

function getRecoverableNotGitStatus(): GitStatusResponse {
  return {
    files: [], ahead: 0, behind: 0, branch: "", repoIdentity: null,
    commitIdentity: null, hasStaged: false, hasUnstaged: false,
    gitAvailable: false, recoverableCode: "NOT_A_GIT_REPOSITORY",
  };
}

function getEmptyDiff(): DiffContent {
  return { oldPath: "", newPath: "", hunks: [], isBinary: false, isNewFile: false, isDeleted: false };
}

function assertPluginResultSuccess(
  payload: unknown,
  operation: "stage" | "unstage" | "commit" | "push" | "createBranch",
): void {
  if (!payload || typeof payload !== "object" || !("success" in payload)) return;
  const candidate = payload as PluginPayload;
  if (candidate.success) return;
  throw new Error(`Git ${operation} failed: ${readPluginErrorMessage(candidate)}`);
}

async function assertSecureApiResponseOk(response: SecureApiResponse, operation: GitAction): Promise<void> {
  if (response.ok) return;
  const payload = await readSecureErrorPayload(response);
  if (payload?.code === "SESSION_BORROW_UNAVAILABLE" || payload?.code === "SESSION_NOT_FOUND" || payload?.code === "SANDBOX_RECOVERY_EXHAUSTED" || payload?.status === "sandbox_unavailable") {
    throw new GitCheckoutUnavailableError();
  }
  const details = await readErrorPreview(response);
  throw new Error(`Git ${operation} failed with HTTP ${response.status}${details ? `: ${details}` : ""}`);
}

async function readSecureErrorPayload(response: SecureApiResponse): Promise<{ code?: string; status?: string } | null> {
  try {
    const value: unknown = await response.clone().json();
    if (!value || typeof value !== "object") return null;
    const candidate = value as { code?: unknown; status?: unknown };
    return {
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
    };
  } catch { return null; }
}

async function readErrorPreview(response: SecureApiResponse): Promise<string> {
  try {
    const payload = await response.clone().json() as { error?: string };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  } catch { /* Fall through to a bounded text preview. */ }
  try {
    const text = (await response.text()).trim();
    if (text) return text.slice(0, 200);
  } catch {
    logWarnRateLimited("git/execution:error-preview-read-failed", `[git/execution] Failed to read error preview body (status=${response.status})`, undefined, ERROR_LOG_WINDOW_MS);
  }
  logWarnRateLimited("git/execution:error-preview-empty", `[git/execution] Empty error preview for non-OK response (status=${response.status} ${response.statusText})`, undefined, ERROR_LOG_WINDOW_MS);
  return "";
}

async function fetchSecureApiWithTimeout(
  service: Env["SECURE_API"],
  url: string,
  init: SecureApiRequestInit,
  timeoutMs: number,
): Promise<SecureApiResponse> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      service.fetch(url, init),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Git request timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function sleep(durationMs: number): Promise<void> {
  if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function mapGitExecutionError(error: unknown, operation: GitOperationName): GitExecutionError {
  if (isSessionStoreUnavailableError(error)) return new GitExecutionError(503, "SESSION_STORE_UNAVAILABLE", "Session store is temporarily unavailable. Please retry.", true);
  if (error instanceof GitCheckoutUnavailableError) return new GitExecutionError(503, "GIT_CHECKOUT_UNAVAILABLE", error.message, false);
  if (error instanceof CommitIdentityError) return new GitExecutionError(error.status, error.code, error.message, false, error.metadata);
  const message = error instanceof Error ? error.message : getDefaultOperationError(operation);
  if (operation === "commit") {
    if (/git commit author is not configured/i.test(message)) return new GitExecutionError(400, "COMMIT_IDENTITY_REQUIRED", "Commit author identity is required before LegionCode can commit. Confirm your name and email, then retry.", false);
    if (/git commit author could not be written/i.test(message)) return new GitExecutionError(500, "COMMIT_IDENTITY_WRITE_FAILED", "LegionCode could not write commit author identity into this workspace. Retry the commit or reconnect the workspace.", false);
  }
  if (operation === "createBranch") return new GitExecutionError(400, "BRANCH_CREATION_FAILED", "LegionCode could not create or switch to that branch. Try a different branch name or refresh the workspace.", false);
  if (operation === "push") return new GitExecutionError(500, "PUSH_FAILED", "LegionCode could not push this branch to GitHub. Reconnect GitHub or retry the push.", false);
  if (operation === "createPullRequest") return new GitExecutionError(500, "PR_CREATION_FAILED", "LegionCode could not create a pull request from this workspace state. Refresh the repo binding or retry after a successful push.", false);
  if (isGitExecutionContractError(message)) return new GitExecutionError(502, "GIT_EXECUTION_CONTRACT_ERROR", "Brain and the secure runtime disagreed on the git execution contract. Refresh and retry.", true);
  if (isTransientGitServiceError(message)) return new GitExecutionError(503, "GIT_SERVICE_UNAVAILABLE", "Git service is temporarily unavailable. Please retry in a few seconds.", true);
  return new GitExecutionError(500, "GIT_OPERATION_FAILED", message, false);
}

function getDefaultOperationError(operation: GitOperationName): string {
  switch (operation) {
    case "getStatus": return "Failed to get git status";
    case "getDiff": return "Failed to get diff";
    case "stageFiles": return "Failed to stage files";
    case "commit": return "Failed to commit";
    case "createBranch": return "Failed to create branch";
    case "push": return "Failed to push branch";
    case "createPullRequest": return "Failed to create pull request";
  }
}

function isGitExecutionContractError(message: string): boolean {
  return message.includes("git.execute") || /invalid enum value/i.test(message) || /received ['"]git\.execute['"]/i.test(message);
}

function isTransientGitServiceError(message: string): boolean {
  return /network connection lost/i.test(message) || /failed to fetch/i.test(message) || /service unavailable/i.test(message) || /timed out/i.test(message) || /econnrefused/i.test(message) || /upstream connect error/i.test(message) || /sandboxerror:\s*http error!\s*status:\s*5\d\d/i.test(message) || /http error!\s*status:\s*5\d\d/i.test(message) || /failed with http 5\d\d/i.test(message) || /couldn't find a local dev session/i.test(message) || /entrypoint of service .* to proxy to/i.test(message);
}
