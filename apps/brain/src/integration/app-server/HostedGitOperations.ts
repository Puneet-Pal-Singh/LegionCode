import {
  AppServerOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import {
  RunAttemptIdSchema,
  RunIdSchema,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import { PostgresTaskWorkspaceRepository } from "@repo/persistence";
import { GitController, type OwnedGitExecution } from "../../controllers/GitController";
import { isDomainError, mapDomainErrorToHttp } from "../../domain/errors";
import { resolveExecutionScope } from "../../controllers/chat-runtime-helpers";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";
import { SecureExecutionSessionClient } from "../../services/secure-execution/SecureExecutionSessionClient";
import { SecureTaskCheckoutRootCapability } from "../../runtime/task-workspaces/TaskCheckoutExecutionOrchestrator";
import { toSecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import type { Env } from "../../types/ai";

type GitRequest = Extract<AppServerRequest, { method: `git/${string}` }>;
type GitParams = GitRequest["params"];

export function composeHostedGitOperations(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedGitOperationsService"]> {
  return {
    status: async (params) => await run("status", params, (execution) => {
      const query = new URLSearchParams({ runId: params.runId });
      return GitController.getStatus(internalRequest(request, "GET", `/api/git/status?${query}`), env, execution);
    }),
    diff: async (params) => await run("diff", params, (execution) => {
      const query = new URLSearchParams({ runId: params.runId });
      if (params.path) query.set("path", params.path);
      if (params.staged !== undefined) query.set("staged", String(params.staged));
      return GitController.getDiff(internalRequest(request, "GET", `/api/git/diff?${query}`), env, execution);
    }),
    stage: async (params) => await run("stage", params, (execution) =>
      GitController.stageFiles(internalRequest(request, "POST", "/api/git/stage", {
        runId: params.runId, sessionId: params.sessionId, files: params.files, unstage: params.unstage,
      }), env, execution)),
    commit: async (params) => await run("commit", params, (execution) =>
      GitController.commit(internalRequest(request, "POST", "/api/git/commit", {
        runId: params.runId, sessionId: params.sessionId, ...params.payload,
      }), env, execution)),
    branch: async (params) => await run("branch", params, (execution) =>
      GitController.createBranch(internalRequest(request, "POST", "/api/git/branch", {
        runId: params.runId, sessionId: params.sessionId, ...params.payload,
      }), env, execution)),
    push: async (params) => await run("push", params, (execution) =>
      GitController.push(internalRequest(request, "POST", "/api/git/push", {
        runId: params.runId, sessionId: params.sessionId, ...params.payload,
      }), env, execution)),
    pullRequest: async (params) => await run("pullRequest", params, (execution) =>
      GitController.createPullRequest(internalRequest(request, "POST", "/api/git/pull-request", {
        runId: params.runId, sessionId: params.sessionId, ...params.payload,
      }), env, execution)),
  };

  async function run<T>(
    operation: string,
    params: GitParams,
    execute: (execution: OwnedGitExecution) => Promise<Response>,
  ): Promise<T> {
    let execution: OwnedGitExecution;
    try {
      execution = await resolveOwnedGitExecution(request, env, userId, params);
    } catch (error) {
      throw mapOwnedGitError(error, operation);
    }
    let response: Response;
    try {
      response = await execute(execution);
    } catch (error) {
      throw mapOwnedGitError(error, operation);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw mapGitResponseError(response.status, payload, operation);
    return payload as T;
  }
}

async function resolveOwnedGitExecution(
  request: Request,
  env: Env,
  userId: string,
  params: GitParams,
): Promise<OwnedGitExecution> {
  const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  const scope = await resolveExecutionScope(request, env, params.runId, correlationId);
  if (scope.userId !== userId) throw notFound("Run not found");

  const run = await withRunRepository(env, (repository) => repository.getRun(params.runId, userId));
  if (!run || (params.sessionId && params.sessionId !== run.sessionId)) {
    throw notFound("Run not found for owned conversation");
  }
  if (!run.workspaceId || run.workspaceId !== scope.workspaceId) {
    throw notFound("Run workspace not found");
  }

  const admission = await withTurnAdmissionRepository(env, (repository) =>
    repository.getBySessionAndRunId(run.sessionId, run.id),
  );
  if (
    !admission || admission.userId !== userId ||
    admission.workspaceId !== scope.workspaceId ||
    admission.state !== "admitted"
  ) {
    throw notFound("No owned turn checkout exists for this run");
  }

  const runAttemptId = RunAttemptIdSchema.parse(admission.runAttemptId);
  const checkout = await withBrainPersistenceRepository(
    env,
    env.AUTH_TASK_WORKSPACE_REPOSITORY,
    (client) => new PostgresTaskWorkspaceRepository(client),
    (repository) => repository.getByRunAttemptId(runAttemptId),
  );
  const expectedWorkspaceId = workspaceIdFromExternalId(scope.workspaceId);
  if (
    !checkout ||
    (checkout.status === "active" && run.status !== "running") ||
    (checkout.status === "settled" && (run.status !== "completed" || !checkout.settledAt)) ||
    (checkout.status !== "active" && checkout.status !== "settled") ||
    checkout.workspaceId !== expectedWorkspaceId ||
    checkout.threadId !== admission.threadId ||
    checkout.turnId !== admission.turnId ||
    checkout.runAttemptId !== runAttemptId
  ) {
    throw unavailable("The original task checkout is unavailable for current Git operations.");
  }

  new SecureTaskCheckoutRootCapability().assertCheckoutRootSupported(checkout, correlationId);
  const runId = RunIdSchema.parse(run.id);
  const workspaceScope = toSecureExecutionWorkspaceScope({
    runId,
    threadId: checkout.threadId,
    turnId: checkout.turnId,
    runAttemptId: checkout.runAttemptId,
    workspaceId: checkout.workspaceId,
    root: checkout.filesystemRoot,
  });
  const sessionClient = new SecureExecutionSessionClient(
    env,
    run.sessionId,
    run.id,
    workspaceScope,
    {
      secureSessionId: checkout.secureSessionId,
      leaseId: checkout.leaseId,
      sandboxId: checkout.sandboxId,
      generation: checkout.generation,
    },
  );
  let session;
  try {
    session = await sessionClient.borrowOriginal();
  } catch {
    throw unavailable("The original task checkout is unavailable for current Git operations.");
  }
  return {
    runId,
    brainSessionId: run.sessionId,
    workspaceScope,
    session,
  };
}

function internalRequest(
  source: Request,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Request {
  const url = new URL(source.url);
  url.pathname = path.split("?", 1)[0]!;
  url.search = path.includes("?") ? path.slice(path.indexOf("?")) : "";
  const headers = new Headers(source.headers);
  if (body) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function mapGitResponseError(status: number, payload: unknown, operation: string): AppServerOperationError {
  const candidate = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const category = status === 400 ? "invalid_request" : status === 401 ? "unauthorized" : status === 404 ? "not_found" : status === 409 ? "conflict" : "server_unavailable";
  const metadata = candidate.metadata && typeof candidate.metadata === "object" ? candidate.metadata as Record<string, unknown> : undefined;
  return new AppServerOperationError(
    status,
    category,
    typeof candidate.error === "string" ? candidate.error : `Git ${operation} failed`,
    typeof candidate.code === "string" ? candidate.code : "GIT_OPERATION_FAILED",
    typeof candidate.retryable === "boolean" ? candidate.retryable : false,
    undefined,
    metadata,
  );
}

function mapOwnedGitError(error: unknown, operation: string): AppServerOperationError {
  if (error instanceof AppServerOperationError) return error;
  if (isDomainError(error)) {
    const mapped = mapDomainErrorToHttp(error);
    const category = mapped.status === 401 ? "unauthorized" : mapped.status === 404 ? "not_found" : mapped.status === 409 ? "conflict" : mapped.status === 400 ? "invalid_request" : "server_unavailable";
    return new AppServerOperationError(mapped.status, category, mapped.message, mapped.code, error.retryable);
  }
  return new AppServerOperationError(503, "server_unavailable", `Git ${operation} is temporarily unavailable`, "GIT_OPERATION_UNAVAILABLE", true);
}

function notFound(message: string): AppServerOperationError {
  return new AppServerOperationError(404, "not_found", message, "GIT_CHECKOUT_NOT_FOUND", false);
}

function unavailable(message: string): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", message, "GIT_CHECKOUT_UNAVAILABLE", false);
}
