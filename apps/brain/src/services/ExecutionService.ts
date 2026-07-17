import { Env } from "../types/ai";
import { decryptToken, GitHubAPIClient } from "@shadowbox/github-bridge";
import {
  sanitizeLogPayload,
  sanitizeLogText,
  sanitizeUnknownError,
} from "../core/security/LogSanitizer";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";
import {
  describeGitHubScopeBoundaryError,
  parseGitHubScopeList,
  resolveGitHubScopeBoundary,
} from "./github/GitHubScopeMatrix";
import { toCanonicalGitExecutionAction } from "../lib/gitExecutionActions";
import type {
  CreatePullRequestFromRunPayload,
  GitStatusResponse,
} from "@repo/shared-types";
import type { ProtocolError } from "@repo/platform-protocol";
import { resolveCommitIdentityForStoredOAuthSession } from "./git/GitCommitIdentityService";
import {
  GIT_MUTATION_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
} from "./gitExecutionTimeouts";
import { getUserSessionByUserId } from "./AuthService";
import {
  parseSecureExecutionOutcome,
  SecureExecutionContractViolationError,
  type SecureExecutionError,
  type SecureExecutionMetrics,
  type SecureExecutionOutcome,
  type SecureExecutionStatus,
} from "./secure-execution/SecureExecutionContract";
import { SecureRuntimeFailureMapper } from "./secure-execution/SecureRuntimeFailureMapper";
import type { SecureExecutionWorkspaceScope } from "../runtime/RuntimeWorkspaceScope";

const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;
const EXECUTION_SESSION_REPO_PATH = ".";
const LOCAL_DEV_SESSION_RETRY_ATTEMPTS = 10;
const LOCAL_DEV_SESSION_RETRY_DELAY_MS = 500;

interface SecureExecutionSession {
  sessionId: string;
  token: string;
}

interface SecureExecutionSessionResponse extends SecureExecutionSession {
  expiresAt: number;
}

type SecureExecutionTaskResponse = SecureExecutionOutcome;

interface SecureExecutionTaskResult {
  outcome: SecureExecutionTaskResponse;
  httpStatus: number;
}

interface LegacyExecutionResult {
  success: boolean;
  status?: SecureExecutionStatus;
  output?: string;
  error?: string | SecureExecutionError;
  metrics?: SecureExecutionMetrics;
  title?: string;
  metadata?: Record<string, unknown>;
  diagnostics?: Array<{ severity: "error"; message: string }>;
  truncated?: boolean;
}

const secureRuntimeFailureMapper = new SecureRuntimeFailureMapper();

interface GitHubAuthState {
  token: string;
  persistedScopes: string[] | null;
}

/**
 * ExecutionService - Handles plugin execution with secure token pass-through
 *
 * Following GEMINI.md:
 * - Brain (Control Plane) handles auth and orchestration
 * - Muscle (Data Plane) handles execution
 * - Tokens are passed securely from Brain to Muscle
 */
export class ExecutionService {
  private executionSessionPromise: Promise<SecureExecutionSession> | null =
    null;
  private releaseExecutionSessionPromise: Promise<void> | null = null;
  private readonly workspaceScope: SecureExecutionWorkspaceScope;

  constructor(
    private env: Env,
    private sessionId: string,
    private runId: string,
    private userId?: string,
    workspaceScope?: SecureExecutionWorkspaceScope,
  ) {
    if (!workspaceScope) {
      throw new Error("workspaceScope is required for secure execution");
    }
    this.workspaceScope = workspaceScope;
  }

  async execute(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
    options?: {
      onOutput?: (chunk: {
        message: string;
        source?: "stdout" | "stderr";
        timestamp?: number;
      }) => Promise<void> | void;
      scope?: SecureExecutionWorkspaceScope;
    },
  ) {
    const scope = options?.scope ?? this.workspaceScope;
    if (!scope) {
      throw new SecureExecutionContractViolationError(
        "workspaceScope is required for secure execution",
        400,
      );
    }
    if (scope.runId !== this.runId) {
      throw new Error("Execution workspace scope does not belong to this run.");
    }
    if (!sameWorkspaceScope(scope, this.workspaceScope)) {
      throw new Error(
        "Execution workspace scope must match the server-owned run scope.",
      );
    }
    const executionAction = normalizeExecutionAction(plugin, action);
    console.log(
      formatDiagnosticLogLine("execution/tool", "requested", {
        runId: this.runId,
        sessionId: this.sessionId,
        plugin,
        action: executionAction,
        payloadKeys: Object.keys(sanitizeLogPayload(payload)).sort().join(","),
      }),
    );

    try {
      payload = await this.prepareExecutionPayload(
        plugin,
        executionAction,
        payload,
      );

      if (plugin === "git" && executionAction === "git_create_pull_request") {
        return await this.executeGitCreatePullRequest(payload, scope);
      }

      const secureExecution = await this.executeSecureTask(
        plugin,
        executionAction,
        payload,
        options,
        scope,
      );
      logExecutionFailure(
        this.runId,
        this.sessionId,
        plugin,
        executionAction,
        secureExecution.outcome,
      );
      return toLegacyExecutionResult(
        secureExecution,
        createSecureExecutionFailureContext(
          plugin,
          executionAction,
          this.runId,
          scope,
        ),
      );
    } catch (error) {
      if (error instanceof SecureExecutionContractViolationError) {
        console.error(
          formatDiagnosticLogLine("execution/tool", "contract-violation", {
            runId: this.runId,
            sessionId: this.sessionId,
            plugin,
            action: executionAction,
            httpStatus: error.httpStatus,
            errorMessage: error.message,
          }),
        );
        return toContractViolationExecutionResult(
          error,
          createSecureExecutionFailureContext(
            plugin,
            executionAction,
            this.runId,
            scope,
          ),
        );
      }
      if (isExpectedGitStatusExecutionError(plugin, executionAction, error)) {
        console.log(
          formatDiagnosticLogLine("execution/tool", "transient-startup-miss", {
            runId: this.runId,
            sessionId: this.sessionId,
            plugin,
            action: executionAction,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error(
          formatDiagnosticLogLine("execution/tool", "threw", {
            runId: this.runId,
            sessionId: this.sessionId,
            plugin,
            action: executionAction,
            error: sanitizeUnknownError(error),
          }),
        );
      }
      throw error;
    }
  }

  /**
   * Execute with explicit user context for token retrieval
   * This overload allows specifying userId at execution time
   */
  async executeWithUser(
    userId: string,
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
  ) {
    // Temporarily set userId for this execution
    const previousUserId = this.userId;
    this.userId = userId;

    try {
      return await this.execute(plugin, action, payload);
    } finally {
      // Restore previous userId
      this.userId = previousUserId;
    }
  }

  /**
   * Release the secure execution lease exactly once after the runtime has
   * settled the run. A missing session is observable terminal evidence: the
   * secure worker may already have expired or released it, but it is not a
   * reason to hide a release failure behind a catch-all.
   */
  async releaseExecutionSession(): Promise<void> {
    if (!this.releaseExecutionSessionPromise) {
      this.releaseExecutionSessionPromise = this.releaseExecutionSessionNow();
    }
    return await this.releaseExecutionSessionPromise;
  }

  private async releaseExecutionSessionNow(): Promise<void> {
    const sessionPromise = this.executionSessionPromise;
    if (!sessionPromise) {
      return;
    }

    let executionSession: SecureExecutionSession;
    try {
      executionSession = await sessionPromise;
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("execution/lease", "release-skipped", {
          runId: this.runId,
          sessionId: this.sessionId,
          reason: "session-creation-failed",
          error: sanitizeUnknownError(error),
        }),
      );
      return;
    }

    const response = await fetchWithTimeout(
      this.env.SECURE_API,
      `http://internal/api/v1/session/${encodeURIComponent(executionSession.sessionId)}?session=${encodeURIComponent(this.sessionId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${executionSession.token}`,
        },
      },
      DEFAULT_EXECUTION_TIMEOUT_MS,
    );

    if (response.status === 404) {
      console.warn(
        formatDiagnosticLogLine("execution/lease", "release-missing", {
          runId: this.runId,
          sessionId: this.sessionId,
          secureSessionId: executionSession.sessionId,
          httpStatus: response.status,
        }),
      );
      return;
    }

    if (!response.ok) {
      const detail = sanitizeLogText((await response.text()) || "unknown");
      throw new Error(
        `Secure execution lease release failed with HTTP ${response.status}: ${detail}`,
      );
    }

    console.log(
      formatDiagnosticLogLine("execution/lease", "released", {
        runId: this.runId,
        sessionId: this.sessionId,
        secureSessionId: executionSession.sessionId,
        httpStatus: response.status,
      }),
    );
  }

  /**
   * Fetch and decrypt GitHub token for a user
   * Tokens are stored encrypted in the canonical identity repository.
   */
  private async getGitHubToken(userId: string): Promise<string | null> {
    const authState = await this.getGitHubAuthState(userId);
    return authState?.token ?? null;
  }

  private async getGitHubAuthState(
    userId: string,
  ): Promise<GitHubAuthState | null> {
    try {
      const session = await getUserSessionByUserId(this.env, userId);
      if (!session) {
        console.log(
          formatDiagnosticLogLine("execution/github-auth", "session-missing", {
            runId: this.runId,
            sessionId: this.sessionId,
            userId,
          }),
        );
        return null;
      }

      const token = await decryptToken(
        session.encryptedToken,
        this.env.GITHUB_TOKEN_ENCRYPTION_KEY,
      );
      const persistedScopes = parseGitHubScopeList(session.githubScopes);

      console.log(
        formatDiagnosticLogLine("execution/github-auth", "token-ready", {
          runId: this.runId,
          sessionId: this.sessionId,
          userId,
          scopeCount: persistedScopes?.length ?? 0,
        }),
      );
      return {
        token,
        persistedScopes,
      };
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("execution/github-auth", "token-failed", {
          runId: this.runId,
          sessionId: this.sessionId,
          userId,
          error: sanitizeUnknownError(error),
        }),
      );
      return null;
    }
  }

  private async prepareExecutionPayload(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const shouldInjectGitHubToken =
      plugin === "git" || plugin === "github" || plugin === "github_cli";
    if (!shouldInjectGitHubToken || !this.userId) {
      return payload;
    }

    const nextPayload = { ...payload };
    const authState = await this.getGitHubAuthState(this.userId);
    if (authState?.token) {
      nextPayload.token = authState.token;
      console.log(
        formatDiagnosticLogLine("execution/github-auth", "token-injected", {
          runId: this.runId,
          sessionId: this.sessionId,
          plugin,
          action,
        }),
      );
    }

    const scopeBoundary = resolveGitHubScopeBoundary({
      plugin,
      action,
      persistedScopes: authState?.persistedScopes ?? null,
    });
    if (scopeBoundary) {
      throw new Error(
        describeGitHubScopeBoundaryError(plugin, action, scopeBoundary),
      );
    }

    if (plugin !== "git" || action !== "git_commit") {
      return nextPayload;
    }

    delete nextPayload.authorName;
    delete nextPayload.authorEmail;
    const commitIdentity = await resolveCommitIdentityForStoredOAuthSession(
      this.env,
      this.userId,
    );
    if (!commitIdentity) {
      return nextPayload;
    }

    nextPayload.authorName = commitIdentity.authorName;
    nextPayload.authorEmail = commitIdentity.authorEmail;
    console.log(
      formatDiagnosticLogLine("execution/git", "commit-identity-resolved", {
        runId: this.runId,
        sessionId: this.sessionId,
        plugin,
        action,
      }),
    );
    return nextPayload;
  }

  private async executeSecureTask(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
    _options:
      | {
          onOutput?: (chunk: {
            message: string;
            source?: "stdout" | "stderr";
            timestamp?: number;
          }) => Promise<void> | void;
        }
      | undefined,
    scope: SecureExecutionWorkspaceScope | undefined,
  ): Promise<SecureExecutionTaskResult> {
    const timeoutMs = resolveExecutionTimeoutMs(plugin, action);
    const executionSession = await this.getExecutionSession(scope);
    const taskId = createExecutionTaskId(plugin, action);
    const startedAt = Date.now();
    console.log(
      formatDiagnosticLogLine("execution/tool", "dispatching", {
        runId: this.runId,
        sessionId: this.sessionId,
        secureSessionId: executionSession.sessionId,
        taskId,
        plugin,
        action,
        timeoutMs,
      }),
    );
    try {
      const res = await fetchWithTimeout(
        this.env.SECURE_API,
        `http://internal/api/v1/execute?session=${encodeURIComponent(this.sessionId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${executionSession.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: executionSession.sessionId,
            taskId,
            action: `${plugin}.execute`,
            params: {
              ...payload,
              runId: this.runId,
              action,
              workspaceScope: scope,
            },
            timeout: timeoutMs,
          }),
        },
        timeoutMs,
      );
      const executionResult = await parseSecureExecutionResponse(res);
      if (!res.ok) {
        console.error(
          formatDiagnosticLogLine("execution/tool", "http-failed", {
            runId: this.runId,
            sessionId: this.sessionId,
            secureSessionId: executionSession.sessionId,
            taskId,
            plugin,
            action,
            httpStatus: res.status,
            elapsedMs: Date.now() - startedAt,
          }),
        );
        if (executionResult) {
          return { outcome: executionResult, httpStatus: res.status };
        }
        throw new SecureExecutionContractViolationError(
          "Secure execution API returned an invalid failure payload",
          res.status,
        );
      }

      if (!executionResult) {
        throw new SecureExecutionContractViolationError(
          "Secure execution API returned an invalid success payload",
          res.status,
        );
      }
      if (executionResult.status !== "success") {
        throw new SecureExecutionContractViolationError(
          `Secure execution API returned ${executionResult.status} with HTTP ${res.status}`,
          res.status,
        );
      }
      console.log(
        formatDiagnosticLogLine("execution/tool", "completed", {
          runId: this.runId,
          sessionId: this.sessionId,
          secureSessionId: executionSession.sessionId,
          taskId,
          plugin,
          action,
          secureStatus: executionResult.status,
          errorCode: executionResult.error?.code,
          durationMs: executionResult.metrics?.duration,
          elapsedMs: Date.now() - startedAt,
        }),
      );
      return { outcome: executionResult, httpStatus: res.status };
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("execution/tool", "failed", {
          runId: this.runId,
          sessionId: this.sessionId,
          secureSessionId: executionSession.sessionId,
          taskId,
          plugin,
          action,
          elapsedMs: Date.now() - startedAt,
          error: sanitizeUnknownError(error),
        }),
      );
      throw error;
    }
  }

  private async executeGitCreatePullRequest(
    payload: Record<string, unknown>,
    scope: SecureExecutionWorkspaceScope | undefined,
  ): Promise<LegacyExecutionResult> {
    try {
      const request = parseGitPullRequestPayload(payload);
      const token =
        readString(payload.token) ??
        (this.userId ? await this.getGitHubToken(this.userId) : null);
      if (!token) {
        return {
          success: false,
          error: "Authenticate with GitHub before creating a pull request.",
        };
      }

      const gitStatusResult = await this.execute(
        "git",
        "git_status",
        {},
        { scope },
      );
      if (!gitStatusResult.success || !gitStatusResult.output) {
        return gitStatusResult;
      }

      const status = parseGitStatusOutput(gitStatusResult.output);
      assertPullRequestWorkspaceBinding(status, request.owner, request.repo);
      const head = status.branch.trim();
      if (head.length === 0) {
        return {
          success: false,
          error:
            "Git status did not return an active branch for pull request creation.",
        };
      }

      const client = new GitHubAPIClient(token);
      const base =
        request.base ??
        (await client.getRepository(request.owner, request.repo))
          .default_branch;
      const pullRequest = await client.createPullRequest(
        request.owner,
        request.repo,
        {
          title: request.title,
          body: request.body,
          head,
          base,
        },
      );

      return {
        success: true,
        output: `Created pull request #${pullRequest.number}: ${pullRequest.html_url}`,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to create pull request.",
      };
    }
  }

  async getArtifact(key: string): Promise<string> {
    const res = await fetchWithTimeout(
      this.env.SECURE_API,
      `http://internal/artifact?key=${encodeURIComponent(key)}`,
      undefined,
      DEFAULT_EXECUTION_TIMEOUT_MS,
    );
    if (!res.ok) return "[Error: Artifact not found]";
    return await res.text();
  }

  private async getExecutionSession(
    scope: SecureExecutionWorkspaceScope | undefined,
  ): Promise<SecureExecutionSession> {
    if (!this.executionSessionPromise) {
      this.executionSessionPromise = this.createExecutionSession(scope);
    }

    try {
      return await this.executionSessionPromise;
    } catch (error) {
      this.executionSessionPromise = null;
      throw error;
    }
  }

  private async createExecutionSession(
    scope: SecureExecutionWorkspaceScope | undefined,
  ): Promise<SecureExecutionSession> {
    for (
      let attempt = 1;
      attempt <= LOCAL_DEV_SESSION_RETRY_ATTEMPTS;
      attempt += 1
    ) {
      const response = await fetchWithTimeout(
        this.env.SECURE_API,
        `http://internal/api/v1/session?session=${encodeURIComponent(this.sessionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: this.runId,
            taskId: createSessionTaskId(this.sessionId),
            repoPath: EXECUTION_SESSION_REPO_PATH,
            workspaceScope: scope,
          }),
        },
        DEFAULT_EXECUTION_TIMEOUT_MS,
      );

      if (response.ok) {
        const session =
          await parseJsonResponse<SecureExecutionSessionResponse>(response);
        return {
          sessionId: session.sessionId,
          token: session.token,
        };
      }

      const message =
        (await response.text()) || "Failed to create secure execution session";
      if (
        attempt < LOCAL_DEV_SESSION_RETRY_ATTEMPTS &&
        isLocalDevSessionProxyMiss(message)
      ) {
        console.log(
          formatDiagnosticLogLine("execution/tool", "session-retry", {
            runId: this.runId,
            sessionId: this.sessionId,
            attempt,
            maxAttempts: LOCAL_DEV_SESSION_RETRY_ATTEMPTS,
          }),
        );
        await sleep(LOCAL_DEV_SESSION_RETRY_DELAY_MS);
        continue;
      }

      throw new Error(message);
    }

    throw new Error("Failed to create secure execution session");
  }

}

function normalizeExecutionAction(plugin: string, action: string): string {
  if (plugin !== "git") {
    return action;
  }
  return toCanonicalGitExecutionAction(action);
}

function resolveExecutionTimeoutMs(plugin: string, action: string): number {
  if (plugin !== "git") {
    return DEFAULT_EXECUTION_TIMEOUT_MS;
  }

  if (action === "git_status") {
    return GIT_STATUS_TIMEOUT_MS;
  }

  return GIT_MUTATION_TIMEOUT_MS;
}

function createSessionTaskId(sessionId: string): string {
  return `brain-session-${sessionId}`;
}

function createExecutionTaskId(plugin: string, action: string): string {
  return `${plugin}-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function parseJsonResponse<T>(
  response: Awaited<ReturnType<Env["SECURE_API"]["fetch"]>>,
): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Expected JSON response from secure execution API: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function parseSecureExecutionResponse(
  response: Awaited<ReturnType<Env["SECURE_API"]["fetch"]>>,
): Promise<SecureExecutionTaskResponse | null> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }

  const outcome = parseSecureExecutionOutcome(body);
  if (outcome && !response.ok && outcome.status !== "success") {
    return outcome;
  }
  if (outcome && response.ok && outcome.status === "success") {
    return outcome;
  }
  if (outcome && response.ok) {
    throw new SecureExecutionContractViolationError(
      `Secure execution API returned ${outcome.status} with HTTP ${response.status}`,
      response.status,
    );
  }
  return null;
}

function toLegacyExecutionResult(
  result: SecureExecutionTaskResult,
  context: Parameters<SecureRuntimeFailureMapper["toRuntimeFailure"]>[2],
): LegacyExecutionResult {
  if (result.outcome.status === "success") {
    return {
      success: true,
      status: result.outcome.status,
      output: result.outcome.output ?? "",
      metrics: result.outcome.metrics,
    };
  }

  const error =
    result.outcome.error ??
    createFallbackSecureExecutionError(
      result.outcome.status,
      result.outcome.output,
    );
  const runtimeFailure = secureRuntimeFailureMapper.toRuntimeFailure(
    result.outcome,
    result.httpStatus,
    context,
  );
  return {
    success: false,
    status: result.outcome.status,
    error,
    output: result.outcome.output,
    metrics: result.outcome.metrics,
    ...toRuntimeToolFailureBridge(runtimeFailure),
  };
}

function toContractViolationExecutionResult(
  error: SecureExecutionContractViolationError,
  context: Parameters<SecureRuntimeFailureMapper["toContractViolation"]>[2],
): LegacyExecutionResult {
  const runtimeFailure = secureRuntimeFailureMapper.toContractViolation(
    error.httpStatus,
    error.message,
    context,
  );
  return {
    success: false,
    error: {
      code: "SECURE_EXECUTION_CONTRACT_VIOLATION",
      message: error.message,
    },
    ...toRuntimeToolFailureBridge(runtimeFailure),
  };
}

function toRuntimeToolFailureBridge(
  runtimeFailure: ProtocolError,
): Pick<
  LegacyExecutionResult,
  "title" | "metadata" | "diagnostics" | "truncated"
> {
  return {
    title: "Secure execution",
    metadata: { success: false, runtimeFailure },
    diagnostics: [{ severity: "error", message: runtimeFailure.message }],
    truncated: false,
  };
}

function createSecureExecutionFailureContext(
  plugin: string,
  action: string,
  runId: string,
  scope: SecureExecutionWorkspaceScope | undefined,
): Parameters<SecureRuntimeFailureMapper["toRuntimeFailure"]>[2] {
  return {
    plugin,
    action,
    runId,
    workspaceScope: scope
      ? {
          threadId: scope.threadId,
          turnId: scope.turnId,
          runAttemptId: scope.runAttemptId,
          workspaceId: scope.workspaceId,
          root: scope.root,
        }
      : undefined,
  };
}

function sameWorkspaceScope(
  left: SecureExecutionWorkspaceScope,
  right: SecureExecutionWorkspaceScope,
): boolean {
  return (
    left.runId === right.runId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.runAttemptId === right.runAttemptId &&
    left.workspaceId === right.workspaceId &&
    left.root === right.root
  );
}

function createFallbackSecureExecutionError(
  status: Exclude<SecureExecutionStatus, "success">,
  output: string | undefined,
): SecureExecutionError {
  return {
    code: `EXECUTION_${status.toUpperCase()}`,
    message: output ?? `Task execution ended with status '${status}'`,
  };
}

function readLegacyExecutionErrorMessage(
  error: LegacyExecutionResult["error"],
): string | undefined {
  if (typeof error === "string") {
    return error;
  }
  return error?.message;
}

function logExecutionFailure(
  runId: string,
  sessionId: string,
  plugin: string,
  action: string,
  result: Pick<SecureExecutionTaskResponse, "status" | "error">,
): void {
  if (result.status === "success") {
    return;
  }

  if (isGitStatusFailure(plugin, action)) {
    const message = isExpectedGitStatusBootstrapFailure(plugin, action, result)
      ? "expected bootstrap miss"
      : "status check failed";
    console.log(
      formatDiagnosticLogLine("execution/tool", "result-warning", {
        runId,
        sessionId,
        plugin,
        action,
        warning: message,
        secureStatus: result.status,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
      }),
    );
    return;
  }

  console.error(
    formatDiagnosticLogLine("execution/tool", "result-failed", {
      runId,
      sessionId,
      plugin,
      action,
      secureStatus: result.status,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      errorDetails: result.error?.details,
    }),
  );
}

function isGitStatusFailure(plugin: string, action: string): boolean {
  return plugin === "git" && action === "git_status";
}

function isExpectedGitStatusBootstrapFailure(
  plugin: string,
  action: string,
  result: Pick<SecureExecutionTaskResponse, "status" | "error">,
): boolean {
  if (plugin !== "git" || action !== "git_status") {
    return false;
  }

  const message = result.error?.message ?? "";
  return isExpectedGitStatusMessage(message);
}

function isExpectedGitStatusExecutionError(
  plugin: string,
  action: string,
  error: unknown,
): boolean {
  if (plugin !== "git" || action !== "git_status") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return isExpectedGitStatusMessage(message);
}

function isExpectedGitStatusMessage(message: string): boolean {
  return (
    /not a git repository/i.test(message) ||
    /sandboxerror:\s*http error!\s*status:\s*5\d\d/i.test(message) ||
    /http error!\s*status:\s*5\d\d/i.test(message) ||
    /failed with http 5\d\d/i.test(message) ||
    /service unavailable/i.test(message) ||
    /network connection lost/i.test(message) ||
    /failed to fetch/i.test(message) ||
    /timed out/i.test(message) ||
    /econnrefused/i.test(message) ||
    /upstream connect error/i.test(message) ||
    /couldn't find a local dev session/i.test(message) ||
    /entrypoint of service .* to proxy to/i.test(message)
  );
}

function isLocalDevSessionProxyMiss(message: string): boolean {
  return (
    /couldn't find a local dev session/i.test(message) ||
    /entrypoint of service .* to proxy to/i.test(message)
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseGitPullRequestPayload(payload: Record<string, unknown>): {
  owner: CreatePullRequestFromRunPayload["owner"];
  repo: CreatePullRequestFromRunPayload["repo"];
  title: CreatePullRequestFromRunPayload["title"];
  body?: CreatePullRequestFromRunPayload["body"];
  base?: CreatePullRequestFromRunPayload["base"];
} {
  const owner = readString(payload.owner);
  const repo = readString(payload.repo);
  const title = readString(payload.title);
  const body = readString(payload.body);
  const base = readString(payload.base);

  if (!owner || !repo || !title) {
    throw new Error("Pull request creation requires owner, repo, and title.");
  }

  return { owner, repo, title, body, base };
}

function parseGitStatusOutput(output: string): GitStatusResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(
      "Git status did not return a valid workspace state for pull request creation.",
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsedRecord.branch !== "string" ||
    typeof parsedRecord.gitAvailable !== "boolean"
  ) {
    throw new Error(
      "Git status did not return a valid workspace state for pull request creation.",
    );
  }

  const status = parsed as GitStatusResponse;
  return status;
}

function assertPullRequestWorkspaceBinding(
  status: GitStatusResponse,
  owner: CreatePullRequestFromRunPayload["owner"],
  repo: CreatePullRequestFromRunPayload["repo"],
): void {
  if (!status.gitAvailable) {
    throw new Error("Git workspace is not ready for pull request creation.");
  }

  const expectedRepoIdentity = `github.com/${owner}/${repo}`.toLowerCase();
  if (!status.repoIdentity || status.repoIdentity !== expectedRepoIdentity) {
    throw new Error(
      "Workspace repository binding does not match the selected GitHub repository for this pull request.",
    );
  }
}

async function fetchWithTimeout(
  service: Env["SECURE_API"],
  input: string,
  init: Parameters<Env["SECURE_API"]["fetch"]>[1],
  timeoutMs: number,
): Promise<Awaited<ReturnType<Env["SECURE_API"]["fetch"]>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Execution request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([service.fetch(input, init), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
