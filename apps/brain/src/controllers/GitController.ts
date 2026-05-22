import { Env } from "../types/ai";
import { getCorsHeaders } from "../lib/cors";
import type {
  GitStatusResponse,
  DiffContent,
  StageFilesRequest,
  CreateBranchPayload,
  CreatePullRequestFromRunPayload,
  GitBranchMutationResult,
  GitMutationErrorMetadata,
  GitPullRequestMutationResult,
  GitPushMutationResult,
} from "@repo/shared-types";
import { decryptToken } from "@shadowbox/github-bridge";
import { z } from "zod";
import { WorkspaceBootstrapService } from "../runtime/services/WorkspaceBootstrapService";
import { sanitizeUnknownError } from "../core/security/LogSanitizer";
import { getBrainRuntimeHeaders } from "../core/observability/runtime";
import {
  logErrorRateLimited,
  logWarnRateLimited,
} from "../lib/rate-limited-log";
import { toCanonicalGitExecutionAction } from "../lib/gitExecutionActions";
import {
  GIT_MUTATION_TIMEOUT_MS as MUSCLE_GIT_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS as MUSCLE_STATUS_TIMEOUT_MS,
} from "../services/gitExecutionTimeouts";
import {
  CommitIdentityError,
  resolveCommitIdentityForCommit,
} from "../services/git/GitCommitIdentityService";
import {
  getAuthenticatedUserSession,
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import {
  canRestoreEditArtifacts,
  EditArtifactRestoreService,
} from "../services/edit-artifacts/EditArtifactRestoreService";

const GitBootstrapRequestBodySchema = z.object({
  runId: z.string(),
  sessionId: z.string().optional(),
  repositoryOwner: z.string(),
  repositoryName: z.string(),
  repositoryBranch: z.string().optional(),
  repositoryBaseUrl: z.string().optional(),
});

const GitCommitRequestBodySchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    message: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
    authorName: z.string().optional(),
    authorEmail: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasAuthorName = typeof value.authorName === "string";
    const hasAuthorEmail = typeof value.authorEmail === "string";
    if (hasAuthorName !== hasAuthorEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorName and authorEmail must be provided together",
        path: hasAuthorName ? ["authorEmail"] : ["authorName"],
      });
    }
  });

const GitCreateBranchRequestBodySchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  branch: z.string().min(1),
});

const GitPushRequestBodySchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  remote: z.string().min(1).optional(),
});

const GitCreatePullRequestRequestBodySchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  base: z.string().min(1).optional(),
});

type GitBootstrapRequestBody = z.infer<typeof GitBootstrapRequestBodySchema>;
type GitBootstrapResult = Awaited<
  ReturnType<WorkspaceBootstrapService["bootstrap"]>
>;
const bootstrapRequestsByRun = new Map<string, Promise<GitBootstrapResult>>();
const ERROR_LOG_WINDOW_MS = 30_000;
const GIT_SESSION_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_ATTEMPTS = 3;
const GIT_STATUS_RETRY_DELAY_MS = 250;
type SecureApiFetch = Env["SECURE_API"]["fetch"];
type SecureApiResponse = Awaited<ReturnType<SecureApiFetch>>;
type SecureApiRequestInit = Parameters<SecureApiFetch>[1];

interface SecureMuscleSession {
  sessionId: string;
  token: string;
}

interface CanonicalExecutionResponse {
  taskId: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  output?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type GitControllerAction =
  | "status"
  | "diff"
  | "stage"
  | "unstage"
  | "commit"
  | "push"
  | "git_fetch"
  | "git_branch_create"
  | "git_branch_switch";

/**
 * GitController
 * Handles Git operations by proxying to Muscle (secure-agent-api)
 * Single Responsibility: Coordinate git commands and responses
 */
export class GitController {
  /**
   * Get git status for a run's worktree
   */
  static async getStatus(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId");
      const sessionId = url.searchParams.get("sessionId");

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      const muscleSession = resolveMuscleSessionId(runId, sessionId);
      let data = await getCurrentGitStatus(env, muscleSession, runId);
      if (canRestoreEditArtifacts(env)) {
        const restoreResult = await restoreLatestEditArtifactIfNeeded(
          req,
          env,
          muscleSession,
          runId,
          data,
          "status",
        );
        if (restoreResult === "restored") {
          data = await getCurrentGitStatus(env, muscleSession, runId);
        }
      }

      return corsJsonResponse(req, env, data);
    } catch (error) {
      if (error instanceof Error && isNotGitRepositoryMessage(error.message)) {
        return corsJsonResponse(req, env, getRecoverableNotGitStatus());
      }
      return handleGitControllerError(req, env, error, "getStatus");
    }
  }

  /**
   * Get diff for specific file or entire worktree
   */
  static async getDiff(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId");
      const sessionId = url.searchParams.get("sessionId");
      const filePath = url.searchParams.get("path");
      const staged = url.searchParams.get("staged") === "true";

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      const muscleSession = resolveMuscleSessionId(runId, sessionId);
      const rawPayload = await executeGitViaCanonicalApi(
        env,
        muscleSession,
        runId,
        "diff",
        {
          path: filePath,
          staged,
        },
        MUSCLE_GIT_TIMEOUT_MS,
      );
      const data = parseGitPayload<DiffContent>(rawPayload, "diff");

      return corsJsonResponse(req, env, data);
    } catch (error) {
      if (error instanceof Error && isNotGitRepositoryMessage(error.message)) {
        return corsJsonResponse(req, env, getEmptyDiff());
      }
      return handleGitControllerError(req, env, error, "getDiff");
    }
  }

  /**
   * Stage files for commit
   */
  static async stageFiles(req: Request, env: Env): Promise<Response> {
    try {
      const body = (await req.json()) as StageFilesRequest & {
        runId: string;
        sessionId?: string;
      };
      const { runId, sessionId, files, unstage = false } = body;

      if (!runId || !files || !Array.isArray(files)) {
        return errorResponse(
          req,
          env,
          "runId and files array are required",
          400,
        );
      }

      const muscleSession = resolveMuscleSessionId(runId, sessionId);
      const rawPayload = await executeGitViaCanonicalApi(
        env,
        muscleSession,
        runId,
        unstage ? "unstage" : "stage",
        { files },
        MUSCLE_GIT_TIMEOUT_MS,
      );
      assertPluginResultSuccess(rawPayload, unstage ? "unstage" : "stage");

      return corsJsonResponse(req, env, { success: true });
    } catch (error) {
      return handleGitControllerError(req, env, error, "stageFiles");
    }
  }

  /**
   * Commit staged changes
   */
  static async commit(req: Request, env: Env): Promise<Response> {
    try {
      const body = GitCommitRequestBodySchema.parse(await req.json());
      const { runId, sessionId, message, files, authorName, authorEmail } =
        body;
      const authenticatedSession = await getAuthenticatedUserSession(req, env);
      const commitIdentity = await resolveCommitIdentityForCommit(
        env,
        authenticatedSession,
        { authorName, authorEmail },
      );

      const muscleSession = resolveMuscleSessionId(runId, sessionId);
      const rawPayload = await executeGitViaCanonicalApi(
        env,
        muscleSession,
        runId,
        "commit",
        {
          message,
          files,
          authorName: commitIdentity?.authorName,
          authorEmail: commitIdentity?.authorEmail,
        },
        MUSCLE_GIT_TIMEOUT_MS,
      );
      assertPluginResultSuccess(rawPayload, "commit");

      return corsJsonResponse(req, env, { success: true });
    } catch (error) {
      return handleGitControllerError(req, env, error, "commit");
    }
  }

  /**
   * Create or switch to a branch for a run's worktree.
   */
  static async createBranch(req: Request, env: Env): Promise<Response> {
    try {
      const body = GitCreateBranchRequestBodySchema.parse(await req.json());
      const { runId, sessionId, branch } = body;
      const muscleSession = resolveMuscleSessionId(runId, sessionId);
      const normalizedBranch = branch.trim();
      const currentBranch = await getCurrentGitBranch(
        env,
        muscleSession,
        runId,
      );

      if (currentBranch === normalizedBranch) {
        return corsJsonResponse(req, env, {
          success: true,
          branch: currentBranch,
        } satisfies GitBranchMutationResult);
      }

      await ensureLocalBranch(env, muscleSession, runId, normalizedBranch);
      const resolvedBranch = await getCurrentGitBranch(
        env,
        muscleSession,
        runId,
      );

      return corsJsonResponse(req, env, {
        success: true,
        branch: resolvedBranch,
      } satisfies GitBranchMutationResult);
    } catch (error) {
      return handleGitControllerError(req, env, error, "createBranch");
    }
  }

  /**
   * Push the active branch for a run's worktree using the authenticated GitHub token.
   */
  static async push(req: Request, env: Env): Promise<Response> {
    try {
      const body = GitPushRequestBodySchema.parse(await req.json());
      const { runId, sessionId } = body;
      const remote = body.remote?.trim() || "origin";
      const authenticatedSession = await getAuthenticatedUserSession(req, env);

      if (!authenticatedSession) {
        return errorResponse(
          req,
          env,
          "Authenticate with GitHub before pushing this branch.",
          401,
          "PUSH_FAILED",
          false,
        );
      }

      const accessToken = await decryptToken(
        authenticatedSession.session.encryptedToken,
        env.GITHUB_TOKEN_ENCRYPTION_KEY,
      );
      const muscleSession = resolveMuscleSessionId(runId, sessionId);
      const branch =
        body.branch?.trim() ||
        (await getCurrentGitBranch(env, muscleSession, runId));
      const rawPayload = await executeGitViaCanonicalApi(
        env,
        muscleSession,
        runId,
        "push",
        {
          remote,
          branch,
          token: accessToken,
        },
        MUSCLE_GIT_TIMEOUT_MS,
      );
      assertPluginResultSuccess(rawPayload, "push");
      const resolvedBranch = await getCurrentGitBranch(
        env,
        muscleSession,
        runId,
      );

      return corsJsonResponse(req, env, {
        success: true,
        branch: resolvedBranch,
        remote,
      } satisfies GitPushMutationResult);
    } catch (error) {
      return handleGitControllerError(req, env, error, "push");
    }
  }

  /**
   * Create a pull request from authoritative run/worktree git state.
   */
  static async createPullRequest(req: Request, env: Env): Promise<Response> {
    try {
      const body = GitCreatePullRequestRequestBodySchema.parse(
        await req.json(),
      );
      const githubAuth = await getGitHubClient(req, env);

      if (!githubAuth) {
        return errorResponse(
          req,
          env,
          "Authenticate with GitHub before creating a pull request.",
          401,
          "PR_CREATION_FAILED",
          false,
        );
      }

      const muscleSession = resolveMuscleSessionId(body.runId, body.sessionId);
      const status = await getCurrentGitStatus(env, muscleSession, body.runId);
      assertPullRequestWorkspaceBinding(status, body.owner, body.repo);
      const head = status.branch.trim();
      if (head.length === 0) {
        throw new Error(
          "Git status did not return an active branch for pull request creation",
        );
      }

      const base =
        body.base?.trim() ||
        (await githubAuth.client.getRepository(body.owner, body.repo))
          .default_branch;

      const pullRequest = await githubAuth.client.createPullRequest(
        body.owner,
        body.repo,
        {
          title: body.title.trim(),
          body: body.body?.trim() || undefined,
          head,
          base,
        },
      );

      return corsJsonResponse(req, env, {
        success: true,
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.html_url,
          state: pullRequest.state,
          head: pullRequest.head.ref,
          base: pullRequest.base.ref,
        },
      } satisfies GitPullRequestMutationResult);
    } catch (error) {
      return handleGitControllerError(req, env, error, "createPullRequest");
    }
  }

  /**
   * Bootstrap git workspace for a run before first chat turn.
   * Enables git status/diff/changes tab in newly-created tasks.
   */
  static async bootstrap(req: Request, env: Env): Promise<Response> {
    try {
      const body = await parseGitBootstrapRequestBody(req, env);
      if (!body) {
        return errorResponse(
          req,
          env,
          "Invalid git bootstrap request body",
          400,
        );
      }
      const {
        runId,
        sessionId,
        repositoryOwner,
        repositoryName,
        repositoryBranch,
        repositoryBaseUrl,
      } = body;

      const normalizedRunId = runId?.trim();
      const owner = repositoryOwner?.trim();
      const repo = repositoryName?.trim();
      const branch = repositoryBranch?.trim() || "main";
      const baseUrl = repositoryBaseUrl?.trim();

      if (!normalizedRunId || !owner || !repo) {
        return errorResponse(
          req,
          env,
          "runId, repositoryOwner, and repositoryName are required",
          400,
        );
      }

      const muscleSession = resolveMuscleSessionId(normalizedRunId, sessionId);
      const existingRequest = bootstrapRequestsByRun.get(normalizedRunId);
      if (existingRequest) {
        const result = await existingRequest;
        return corsJsonResponse(req, env, result);
      }

      const bootstrapper = WorkspaceBootstrapService.fromEnv(
        env,
        muscleSession,
        normalizedRunId,
      );
      const bootstrapRequest = bootstrapper.bootstrap({
        runId: normalizedRunId,
        mode: "mutation",
        repositoryContext: {
          owner,
          repo,
          branch,
          baseUrl,
        },
      });
      bootstrapRequestsByRun.set(normalizedRunId, bootstrapRequest);

      let result: GitBootstrapResult;
      try {
        result = await bootstrapRequest;
      } finally {
        if (bootstrapRequestsByRun.get(normalizedRunId) === bootstrapRequest) {
          bootstrapRequestsByRun.delete(normalizedRunId);
        }
      }

      if (result.status === "ready" && canRestoreEditArtifacts(env)) {
        const currentStatus = await getCurrentGitStatus(
          env,
          muscleSession,
          normalizedRunId,
        );
        await restoreLatestEditArtifactIfNeeded(
          req,
          env,
          muscleSession,
          normalizedRunId,
          currentStatus,
          "bootstrap",
        );
      }

      return corsJsonResponse(req, env, result);
    } catch (error) {
      return handleGitControllerError(req, env, error, "bootstrap");
    }
  }
}

async function parseGitBootstrapRequestBody(
  req: Request,
  env: Env,
): Promise<GitBootstrapRequestBody | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    logWarnRateLimited(
      "GitController:bootstrap:invalid-json",
      "[GitController:bootstrap] Invalid JSON body",
      { error: sanitizeUnknownError(error) },
      ERROR_LOG_WINDOW_MS,
    );
    return null;
  }

  const parsedBody = GitBootstrapRequestBodySchema.safeParse(body);
  if (!parsedBody.success) {
    logWarnRateLimited(
      "GitController:bootstrap:validation-failed",
      "[GitController:bootstrap] Body validation failed",
      {
        issues: parsedBody.error.issues,
        environment: env.NODE_ENV,
      },
      ERROR_LOG_WINDOW_MS,
    );
    return null;
  }

  return parsedBody.data;
}

interface PluginSuccessPayload {
  success: true;
  output?: unknown;
}

function resolveMuscleSessionId(
  runId: string,
  sessionId?: string | null,
): string {
  const normalizedSessionId = sessionId?.trim();
  if (normalizedSessionId && normalizedSessionId.length > 0) {
    return normalizedSessionId;
  }
  return runId;
}

interface PluginErrorPayload {
  success: false;
  error?: string;
}

async function executeGitViaCanonicalApi(
  env: Env,
  muscleSession: string,
  runId: string,
  action: GitControllerAction,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<PluginSuccessPayload | PluginErrorPayload> {
  const secureSession = await createSecureMuscleSession(
    env.SECURE_API,
    muscleSession,
    runId,
    action,
  );

  const response = await fetchSecureApiWithTimeout(
    env.SECURE_API,
    buildSecureApiUrl(muscleSession, "/api/v1/execute"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secureSession.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: secureSession.sessionId,
        taskId: createGitTaskId(action),
        action: "git.execute",
        params: {
          action: toCanonicalGitExecutionAction(action),
          runId,
          ...payload,
        },
        timeout: timeoutMs,
      }),
    },
    timeoutMs,
  );

  await assertMuscleResponseOk(response, action);
  const canonicalResponse = parseCanonicalExecutionResponse(
    (await response.json()) as unknown,
  );
  return normalizeCanonicalGitResponse(canonicalResponse);
}

async function getCurrentGitStatus(
  env: Env,
  muscleSession: string,
  runId: string,
): Promise<GitStatusResponse> {
  const rawPayload = await executeGitStatusViaCanonicalApiWithRetry(
    env,
    muscleSession,
    runId,
  );
  return parseGitPayload<GitStatusResponse>(rawPayload, "status");
}

async function restoreLatestEditArtifactIfNeeded(
  request: Request,
  env: Env,
  muscleSession: string,
  runId: string,
  currentStatus: GitStatusResponse,
  logScope: "bootstrap" | "status",
): Promise<"not-needed" | "restored" | "requires-user-resolution"> {
  try {
    const authenticatedSession = await getAuthenticatedUserSession(request, env);
    if (!authenticatedSession) {
      return "not-needed";
    }
    const restoreService = new EditArtifactRestoreService(env);
    const result = await restoreService.restoreLatestIfWorkspaceIsEmpty({
      userId: authenticatedSession.userId,
      runId,
      muscleSession,
      currentStatus,
    });
    if (result === "restored") {
      logWarnRateLimited(
        `GitController:${logScope}:artifact-restored:${runId}`,
        `[GitController:${logScope}] Restored saved edit artifact into workspace`,
        undefined,
        ERROR_LOG_WINDOW_MS,
      );
    }
    return result;
  } catch (error) {
    logWarnRateLimited(
      `GitController:${logScope}:artifact-restore-failed:${runId}`,
      `[GitController:${logScope}] Edit artifact restore did not complete`,
      { error: sanitizeUnknownError(error) },
      ERROR_LOG_WINDOW_MS,
    );
    return "requires-user-resolution";
  }
}

async function executeGitStatusViaCanonicalApiWithRetry(
  env: Env,
  muscleSession: string,
  runId: string,
): Promise<PluginSuccessPayload | PluginErrorPayload> {
  for (let attempt = 1; attempt <= GIT_STATUS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = await executeGitViaCanonicalApi(
        env,
        muscleSession,
        runId,
        "status",
        {},
        MUSCLE_STATUS_TIMEOUT_MS,
      );
      if (
        attempt < GIT_STATUS_MAX_ATTEMPTS &&
        shouldRetryGitStatusPayload(payload)
      ) {
        const delayMs = GIT_STATUS_RETRY_DELAY_MS * attempt;
        logWarnRateLimited(
          `GitController:getStatus:retry-payload:${runId}`,
          `[GitController:getStatus] Retrying transient git status plugin failure (attempt ${attempt + 1}/${GIT_STATUS_MAX_ATTEMPTS})`,
          undefined,
          ERROR_LOG_WINDOW_MS,
        );
        await sleep(delayMs);
        continue;
      }
      return payload;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        attempt >= GIT_STATUS_MAX_ATTEMPTS ||
        !isTransientGitServiceError(errorMessage) ||
        isGitExecutionContractError(errorMessage)
      ) {
        throw error;
      }

      const delayMs = GIT_STATUS_RETRY_DELAY_MS * attempt;
      logWarnRateLimited(
        `GitController:getStatus:retry-throw:${runId}`,
        `[GitController:getStatus] Retrying transient git status error (attempt ${attempt + 1}/${GIT_STATUS_MAX_ATTEMPTS})`,
        { error: sanitizeUnknownError(error) },
        ERROR_LOG_WINDOW_MS,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("Git status retry loop terminated unexpectedly.");
}

async function getCurrentGitBranch(
  env: Env,
  muscleSession: string,
  runId: string,
): Promise<string> {
  const status = await getCurrentGitStatus(env, muscleSession, runId);
  const branch = status.branch.trim();
  if (branch.length === 0) {
    throw new Error("Git status did not return an active branch");
  }
  return branch;
}

async function ensureLocalBranch(
  env: Env,
  muscleSession: string,
  runId: string,
  branch: CreateBranchPayload["branch"],
): Promise<void> {
  const switchPayload = await executeGitViaCanonicalApi(
    env,
    muscleSession,
    runId,
    "git_branch_switch",
    { branch },
    MUSCLE_GIT_TIMEOUT_MS,
  );
  if (!isPluginErrorPayload(switchPayload)) {
    return;
  }

  const switchError = readPluginErrorMessage(switchPayload);
  if (!isMissingBranchMessage(switchError)) {
    throw new Error(`Git createBranch failed: ${switchError}`);
  }

  try {
    await executeGitViaCanonicalApi(
      env,
      muscleSession,
      runId,
      "git_fetch",
      { remote: "origin" },
      MUSCLE_GIT_TIMEOUT_MS,
    );
  } catch {
    // Non-fatal — continue to retry switch / create branch
  }

  const retrySwitchPayload = await executeGitViaCanonicalApi(
    env,
    muscleSession,
    runId,
    "git_branch_switch",
    { branch },
    MUSCLE_GIT_TIMEOUT_MS,
  );
  if (!isPluginErrorPayload(retrySwitchPayload)) {
    return;
  }

  const createPayload = await executeGitViaCanonicalApi(
    env,
    muscleSession,
    runId,
    "git_branch_create",
    { branch },
    MUSCLE_GIT_TIMEOUT_MS,
  );
  assertPluginResultSuccess(createPayload, "createBranch");
}

async function createSecureMuscleSession(
  service: Env["SECURE_API"],
  muscleSession: string,
  runId: string,
  action: string,
): Promise<SecureMuscleSession> {
  const response = await fetchSecureApiWithTimeout(
    service,
    buildSecureApiUrl(muscleSession, "/api/v1/session"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId,
        taskId: `git-${action}-${runId}`,
        repoPath: ".",
      }),
    },
    GIT_SESSION_TIMEOUT_MS,
  );

  if (!response.ok) {
    const details = await readErrorPreview(response);
    const suffix = details ? `: ${details}` : "";
    throw new Error(
      `Git ${action} failed to create execution session with HTTP ${response.status}${suffix}`,
    );
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("Git execution session returned an invalid response");
  }

  const candidate = payload as {
    sessionId?: unknown;
    token?: unknown;
  };
  if (
    typeof candidate.sessionId !== "string" ||
    typeof candidate.token !== "string"
  ) {
    throw new Error("Git execution session response is missing credentials");
  }

  return {
    sessionId: candidate.sessionId,
    token: candidate.token,
  };
}

function buildSecureApiUrl(muscleSession: string, pathname: string): string {
  const url = new URL(pathname, "http://internal/");
  url.searchParams.set("session", muscleSession);
  return url.toString();
}

function parseCanonicalExecutionResponse(
  payload: unknown,
): CanonicalExecutionResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("Git execution returned an invalid response payload");
  }

  const candidate = payload as {
    taskId?: unknown;
    status?: unknown;
    output?: unknown;
    error?: unknown;
  };
  if (
    typeof candidate.taskId !== "string" ||
    (candidate.status !== "success" &&
      candidate.status !== "failure" &&
      candidate.status !== "timeout" &&
      candidate.status !== "cancelled")
  ) {
    throw new Error("Git execution returned an invalid canonical response");
  }

  const error = parseCanonicalExecutionError(candidate.error);
  return {
    taskId: candidate.taskId,
    status: candidate.status,
    output: typeof candidate.output === "string" ? candidate.output : undefined,
    error,
  };
}

function parseCanonicalExecutionError(
  payload: unknown,
): CanonicalExecutionResponse["error"] {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string"
  ) {
    return undefined;
  }

  return {
    code: candidate.code,
    message: candidate.message,
    details: candidate.details,
  };
}

function normalizeCanonicalGitResponse(
  payload: CanonicalExecutionResponse,
): PluginSuccessPayload | PluginErrorPayload {
  if (payload.status === "success") {
    return {
      success: true,
      output: payload.output,
    };
  }

  return {
    success: false,
    error:
      payload.error?.message ??
      `Git task ended with status '${payload.status}'`,
  };
}

function createGitTaskId(action: GitControllerAction): string {
  return `git-${action.replace(/_/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPluginPayload(
  payload: unknown,
): payload is PluginSuccessPayload | PluginErrorPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return "success" in payload;
}

function isPluginErrorPayload(payload: unknown): payload is PluginErrorPayload {
  return isPluginPayload(payload) && payload.success === false;
}

function shouldRetryGitStatusPayload(
  payload: PluginSuccessPayload | PluginErrorPayload,
): boolean {
  if (!isPluginErrorPayload(payload)) {
    return false;
  }
  const errorMessage = readPluginErrorMessage(payload);
  return (
    isTransientGitServiceError(errorMessage) &&
    !isGitExecutionContractError(errorMessage)
  );
}

function readPluginErrorMessage(payload: PluginErrorPayload): string {
  return typeof payload.error === "string" && payload.error.trim().length > 0
    ? payload.error.trim()
    : "unknown plugin error";
}

function parseGitPayload<T>(payload: unknown, operation: "status" | "diff"): T {
  if (isPluginPayload(payload)) {
    if (payload.success === false) {
      const details =
        typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error.trim()
          : "unknown plugin error";
      if (operation === "status" && isNotGitRepositoryMessage(details)) {
        return getRecoverableNotGitStatus() as unknown as T;
      }
      if (operation === "diff" && isNotGitRepositoryMessage(details)) {
        return getEmptyDiff() as unknown as T;
      }
      throw new Error(`Git ${operation} failed: ${details}`);
    }

    if (payload.output === undefined) {
      throw new Error(`Git ${operation} returned no output payload`);
    }

    return parseGitOutput<T>(payload.output, operation);
  }

  return payload as T;
}

function isNotGitRepositoryMessage(message: string): boolean {
  return /not a git repository/i.test(message);
}

function isMissingBranchMessage(message: string): boolean {
  return (
    /pathspec .* did not match any file/i.test(message) ||
    /invalid reference/i.test(message) ||
    /not a valid object name/i.test(message) ||
    /unknown revision or path/i.test(message)
  );
}

function assertPullRequestWorkspaceBinding(
  status: GitStatusResponse,
  owner: CreatePullRequestFromRunPayload["owner"],
  repo: CreatePullRequestFromRunPayload["repo"],
): void {
  if (!status.gitAvailable) {
    throw new Error("Git workspace is not ready for pull request creation");
  }

  const expectedRepoIdentity = buildExpectedRepoIdentity(owner, repo);
  if (!status.repoIdentity || status.repoIdentity !== expectedRepoIdentity) {
    throw new Error(
      "Workspace repository binding does not match the selected GitHub repository for this pull request",
    );
  }
}

function buildExpectedRepoIdentity(owner: string, repo: string): string {
  return `github.com/${owner}/${repo}`.toLowerCase();
}

function getRecoverableNotGitStatus(): GitStatusResponse {
  return {
    files: [],
    ahead: 0,
    behind: 0,
    branch: "",
    repoIdentity: null,
    commitIdentity: null,
    hasStaged: false,
    hasUnstaged: false,
    gitAvailable: false,
    recoverableCode: "NOT_A_GIT_REPOSITORY",
  };
}

function getEmptyDiff(): DiffContent {
  return {
    oldPath: "",
    newPath: "",
    hunks: [],
    isBinary: false,
    isNewFile: false,
    isDeleted: false,
  };
}

function parseGitOutput<T>(output: unknown, operation: "status" | "diff"): T {
  if (typeof output === "string") {
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error(`Git ${operation} returned invalid JSON output`);
    }
  }

  if (output && typeof output === "object") {
    return output as T;
  }

  throw new Error(`Git ${operation} returned unsupported output format`);
}

function corsJsonResponse(
  req: Request,
  env: Env,
  data: unknown,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(req, env),
      ...getBrainRuntimeHeaders(env),
    },
  });
}

function handleGitControllerError(
  req: Request,
  env: Env,
  error: unknown,
  operation:
    | "getStatus"
    | "getDiff"
    | "stageFiles"
    | "commit"
    | "createBranch"
    | "createPullRequest"
    | "push"
    | "bootstrap",
): Response {
  const mapped = mapGitControllerError(error, operation);
  const logMessage = `[GitController:${operation}] ${mapped.code}: ${mapped.message}`;
  const logKey = `GitController:${operation}:${mapped.code}:${mapped.message}`;

  if (mapped.retryable) {
    logWarnRateLimited(
      logKey,
      logMessage,
      { error: sanitizeUnknownError(error) },
      ERROR_LOG_WINDOW_MS,
    );
  } else {
    logErrorRateLimited(
      logKey,
      logMessage,
      sanitizeUnknownError(error),
      ERROR_LOG_WINDOW_MS,
    );
  }

  return errorResponse(
    req,
    env,
    mapped.message,
    mapped.status,
    mapped.code,
    mapped.retryable,
    mapped.metadata,
  );
}

function mapGitControllerError(
  error: unknown,
  operation:
    | "getStatus"
    | "getDiff"
    | "stageFiles"
    | "commit"
    | "createBranch"
    | "createPullRequest"
    | "push"
    | "bootstrap",
): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  metadata?: GitMutationErrorMetadata;
} {
  if (isSessionStoreUnavailableError(error)) {
    return {
      status: 503,
      code: "SESSION_STORE_UNAVAILABLE",
      message: "Session store is temporarily unavailable. Please retry.",
      retryable: true,
    };
  }

  if (error instanceof CommitIdentityError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: false,
      metadata: error.metadata,
    };
  }

  const fallbackMessage = getDefaultOperationError(operation);
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (operation === "commit") {
    if (isMissingCommitIdentityMessage(message)) {
      return {
        status: 400,
        code: "COMMIT_IDENTITY_REQUIRED",
        message:
          "Commit author identity is required before LegionCode can commit. Confirm your name and email, then retry.",
        retryable: false,
      };
    }

    if (isCommitIdentityWriteFailedMessage(message)) {
      return {
        status: 500,
        code: "COMMIT_IDENTITY_WRITE_FAILED",
        message:
          "LegionCode could not write commit author identity into this workspace. Retry the commit or reconnect the workspace.",
        retryable: false,
      };
    }
  }

  if (operation === "createBranch") {
    return {
      status: 400,
      code: "BRANCH_CREATION_FAILED",
      message:
        "LegionCode could not create or switch to that branch. Try a different branch name or refresh the workspace.",
      retryable: false,
      metadata: undefined,
    };
  }

  if (operation === "push") {
    return {
      status: 500,
      code: "PUSH_FAILED",
      message:
        "LegionCode could not push this branch to GitHub. Reconnect GitHub or retry the push.",
      retryable: false,
      metadata: undefined,
    };
  }

  if (operation === "createPullRequest") {
    return {
      status: 500,
      code: "PR_CREATION_FAILED",
      message:
        "LegionCode could not create a pull request from this workspace state. Refresh the repo binding or retry after a successful push.",
      retryable: false,
      metadata: undefined,
    };
  }

  if (isGitExecutionContractError(message)) {
    return {
      status: 502,
      code: "GIT_EXECUTION_CONTRACT_ERROR",
      message:
        "Git workspace bootstrap failed because Brain and the secure runtime disagreed on the git execution contract. Refresh and retry.",
      retryable: true,
      metadata: undefined,
    };
  }

  if (isTransientGitServiceError(message)) {
    return {
      status: 503,
      code: "GIT_SERVICE_UNAVAILABLE",
      message:
        "Git service is temporarily unavailable. Please retry in a few seconds.",
      retryable: true,
      metadata: undefined,
    };
  }

  return {
    status: 500,
    code: "GIT_OPERATION_FAILED",
    message,
    retryable: false,
    metadata: undefined,
  };
}

function isMissingCommitIdentityMessage(message: string): boolean {
  return /git commit author is not configured/i.test(message);
}

function isCommitIdentityWriteFailedMessage(message: string): boolean {
  return /git commit author could not be written/i.test(message);
}

function isGitExecutionContractError(message: string): boolean {
  return (
    message.includes("git.execute") ||
    /invalid enum value/i.test(message) ||
    /received ['"]git\.execute['"]/i.test(message)
  );
}

function isTransientGitServiceError(message: string): boolean {
  return (
    /network connection lost/i.test(message) ||
    /failed to fetch/i.test(message) ||
    /service unavailable/i.test(message) ||
    /timed out/i.test(message) ||
    /econnrefused/i.test(message) ||
    /upstream connect error/i.test(message) ||
    /sandboxerror:\s*http error!\s*status:\s*5\d\d/i.test(message) ||
    /http error!\s*status:\s*5\d\d/i.test(message) ||
    /failed with http 5\d\d/i.test(message) ||
    /couldn't find a local dev session/i.test(message) ||
    /entrypoint of service .* to proxy to/i.test(message)
  );
}

function getDefaultOperationError(
  operation:
    | "getStatus"
    | "getDiff"
    | "stageFiles"
    | "commit"
    | "createBranch"
    | "createPullRequest"
    | "push"
    | "bootstrap",
): string {
  switch (operation) {
    case "getStatus":
      return "Failed to get git status";
    case "getDiff":
      return "Failed to get diff";
    case "stageFiles":
      return "Failed to stage files";
    case "commit":
      return "Failed to commit";
    case "createBranch":
      return "Failed to create branch";
    case "push":
      return "Failed to push branch";
    case "createPullRequest":
      return "Failed to create pull request";
    case "bootstrap":
      return "Failed to bootstrap git workspace";
  }
}

function errorResponse(
  req: Request,
  env: Env,
  message: string,
  status: number,
  code?: string,
  retryable?: boolean,
  metadata?: GitMutationErrorMetadata,
): Response {
  const payload = {
    error: message,
    ...(code ? { code } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(metadata ? { metadata } : {}),
  };

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(req, env),
      ...getBrainRuntimeHeaders(env),
    },
  });
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
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Git request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function sleep(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function assertMuscleResponseOk(
  response: SecureApiResponse,
  operation: GitControllerAction,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const details = await readErrorPreview(response);
  const suffix = details ? `: ${details}` : "";
  throw new Error(
    `Git ${operation} failed with HTTP ${response.status}${suffix}`,
  );
}

function assertPluginResultSuccess(
  payload: unknown,
  operation: "stage" | "unstage" | "commit" | "push" | "createBranch",
): void {
  if (!isPluginPayload(payload)) {
    return;
  }
  if (payload.success) {
    return;
  }

  const details =
    typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error.trim()
      : "unknown plugin error";
  throw new Error(`Git ${operation} failed: ${details}`);
}

async function readErrorPreview(response: SecureApiResponse): Promise<string> {
  try {
    const payload = (await response.clone().json()) as { error?: string };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error.trim();
    }
  } catch {
    // No-op: fallback to text preview.
  }

  try {
    const text = (await response.text()).trim();
    if (text.length > 0) {
      return text.slice(0, 200);
    }
  } catch {
    logWarnRateLimited(
      "git/controller:error-preview-read-failed",
      `[git/controller] Failed to read error preview body (status=${response.status})`,
      undefined,
      ERROR_LOG_WINDOW_MS,
    );
  }

  logWarnRateLimited(
    "git/controller:error-preview-empty",
    `[git/controller] Empty error preview for non-OK response (status=${response.status} ${response.statusText})`,
    undefined,
    ERROR_LOG_WINDOW_MS,
  );
  return "";
}
