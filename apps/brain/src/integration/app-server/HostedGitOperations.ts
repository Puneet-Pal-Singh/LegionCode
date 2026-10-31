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
import { isDomainError, mapDomainErrorToHttp } from "../../domain/errors";
import { resolveExecutionScope } from "../../controllers/chat-runtime-helpers";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";
import { SecureExecutionSessionClient } from "../../services/secure-execution/SecureExecutionSessionClient";
import { SecureTaskCheckoutRootCapability } from "../../runtime/task-workspaces/TaskCheckoutExecutionOrchestrator";
import { toSecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import {
  GitExecutionError,
  GitExecutionService,
  type OwnedGitExecution,
} from "../../services/git/GitExecutionService";
import type { Env } from "../../types/ai";

type GitRequest = Extract<AppServerRequest, { method: `git/${string}` }>;
type GitParams = GitRequest["params"];

export function composeHostedGitOperations(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedGitOperationsService"]> {
  return {
    status: async (params) => await run("status", params, (operations) => operations.status(params)),
    diff: async (params) => await run("diff", params, (operations) => operations.diff(params)),
    stage: async (params) => await run("stage", params, (operations) => operations.stage(params)),
    commit: async (params) => await run("commit", params, (operations) => operations.commit(request, params)),
    branch: async (params) => await run("branch", params, (operations) => operations.branch(params)),
    push: async (params) => await run("push", params, (operations) => operations.push(request, params)),
    pullRequest: async (params) => await run("pullRequest", params, (operations) => operations.pullRequest(request, params)),
  };

  async function run<T>(
    operation: string,
    params: GitParams,
    execute: (operations: GitExecutionService) => Promise<T>,
  ): Promise<T> {
    let execution: OwnedGitExecution;
    try {
      execution = await resolveOwnedGitExecution(request, env, userId, params);
    } catch (error) {
      throw mapOwnedGitError(error, operation);
    }
    try {
      return await execute(new GitExecutionService(env, execution));
    } catch (error) {
      throw mapOwnedGitError(error, operation);
    }
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
    admission.workspaceId !== scope.workspaceId || admission.state !== "admitted"
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
  try {
    return {
      runId,
      brainSessionId: run.sessionId,
      workspaceScope,
      session: await sessionClient.borrowOriginal(),
    };
  } catch {
    throw unavailable("The original task checkout is unavailable for current Git operations.");
  }
}

function mapOwnedGitError(error: unknown, operation: string): AppServerOperationError {
  if (error instanceof AppServerOperationError) return error;
  if (error instanceof GitExecutionError) {
    return new AppServerOperationError(
      error.status,
      appServerCategory(error.status),
      error.message,
      error.code,
      error.retryable,
      undefined,
      error.metadata ? { ...error.metadata } : undefined,
    );
  }
  if (isDomainError(error)) {
    const mapped = mapDomainErrorToHttp(error);
    return new AppServerOperationError(
      mapped.status,
      appServerCategory(mapped.status),
      mapped.message,
      mapped.code,
      error.retryable,
      error.correlationId,
      mapped.metadata,
    );
  }
  return new AppServerOperationError(
    503,
    "server_unavailable",
    `Git ${operation} is temporarily unavailable`,
    "GIT_OPERATION_UNAVAILABLE",
    true,
  );
}

function appServerCategory(status: number): "invalid_request" | "unauthorized" | "not_found" | "conflict" | "server_unavailable" {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "server_unavailable";
}

function notFound(message: string): AppServerOperationError {
  return new AppServerOperationError(404, "not_found", message, "GIT_CHECKOUT_NOT_FOUND", false);
}

function unavailable(message: string): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", message, "GIT_CHECKOUT_UNAVAILABLE", false);
}
