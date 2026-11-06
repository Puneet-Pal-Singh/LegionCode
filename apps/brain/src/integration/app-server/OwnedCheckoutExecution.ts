import { AppServerOperationError } from "@legioncode/app-server/server";
import { RunAttemptIdSchema, RunIdSchema, workspaceIdFromExternalId } from "@repo/platform-protocol";
import { PostgresTaskWorkspaceRepository } from "@repo/persistence";
import { resolveExecutionScope } from "../../controllers/chat-runtime-helpers";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";
import { SecureExecutionSessionClient, type SecureExecutionSessionHandle } from "../../services/secure-execution/SecureExecutionSessionClient";
import { SecureTaskCheckoutRootCapability } from "../../runtime/task-workspaces/TaskCheckoutExecutionOrchestrator";
import { toSecureExecutionWorkspaceScope, type SecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import type { Env } from "../../types/ai";

export interface OwnedCheckoutExecution {
  readonly runId: string;
  readonly brainSessionId: string;
  readonly workspaceScope: SecureExecutionWorkspaceScope;
  readonly session: SecureExecutionSessionHandle;
}

/** Authorize and borrow the exact original checkout; never create, renew or recover it. */
export async function resolveOwnedCheckoutExecution(
  request: Request,
  env: Env,
  userId: string,
  params: { runId: string; sessionId?: string },
): Promise<OwnedCheckoutExecution> {
  const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  const scope = await resolveExecutionScope(request, env, params.runId, correlationId);
  if (scope.userId !== userId) throw checkoutNotFound("Run not found");

  const run = await withRunRepository(env, (repository) => repository.getRun(params.runId, userId));
  if (!run || (params.sessionId && params.sessionId !== run.sessionId)) {
    throw checkoutNotFound("Run not found for owned conversation");
  }
  if (!run.workspaceId || run.workspaceId !== scope.workspaceId) {
    throw checkoutNotFound("Run workspace not found");
  }

  const admission = await withTurnAdmissionRepository(env, (repository) =>
    repository.getBySessionAndRunId(run.sessionId, run.id),
  );
  if (
    !admission || admission.userId !== userId ||
    admission.workspaceId !== scope.workspaceId || admission.state !== "admitted"
  ) {
    throw checkoutNotFound("No owned turn checkout exists for this run");
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
    throw checkoutUnavailable("The original task checkout is unavailable for checkout access.");
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
    throw checkoutUnavailable("The original task checkout is unavailable for checkout access.");
  }
}

function checkoutNotFound(message: string): AppServerOperationError {
  return new AppServerOperationError(404, "not_found", message, "CHECKOUT_NOT_FOUND", false);
}
function checkoutUnavailable(message: string): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", message, "CHECKOUT_UNAVAILABLE", false);
}
