import { AppServerOperationError, type HarnessOperations } from "@legioncode/app-server/server";
import type { HarnessStatusRequest } from "@repo/platform-protocol";
import { isDomainError } from "../../domain/errors";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import type { Env } from "../../types/ai";

/** Supplied exclusively from the verified App Server principal, never the body. */
export interface HostedHarnessOperationContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

/** P12's connection authority implements this boundary. Each method must verify
 * environment/instance/connection ownership and placement eligibility against the
 * verified principal before host/provider work. select additionally owns durable
 * revision CAS and command deduplication; no preference lives in this adapter.
 */
export type HostedHarnessConnectionService = {
  [Method in keyof HarnessOperations]: (
    context: HostedHarnessOperationContext,
    params: Parameters<HarnessOperations[Method]>[0],
  ) => ReturnType<HarnessOperations[Method]>;
};

export function composeHostedHarnessOperations(
  request: Request,
  env: Env,
  userId: string,
  service: HostedHarnessConnectionService,
): HarnessOperations {
  const operation = async <Params extends HarnessStatusRequest, Result>(
    params: Params,
    action: (context: HostedHarnessOperationContext) => Promise<Result>,
  ): Promise<Result> => {
    const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
    try {
      // Explicit workspace authorization: changing the UI's current workspace
      // cannot retarget a saved Thread or authorize an unrelated setup request.
      const owned = await withWorkspaceRepository(env, async (repository) =>
        (await repository.listWorkspaces(userId)).some(({ workspace }) =>
          workspace.id === params.workspaceId && workspace.userId === userId && workspace.status === "active",
        ),
      );
      if (!owned) throw new AppServerOperationError(404, "not_found", "Workspace not found");
      if ("sessionId" in params && "threadId" in params) {
        const session = await withTranscriptRepository(env, async (repository) =>
          (await repository.listSessions(userId)).sessions.find((candidate) => candidate.id === params.sessionId),
        );
        if (!session || session.userId !== userId || session.workspaceId !== params.workspaceId || session.threadId !== params.threadId) {
          throw new AppServerOperationError(404, "not_found", "Conversation not found");
        }
      }
      return await action({ userId, workspaceId: params.workspaceId, environmentId: params.environmentId, correlationId, signal: request.signal });
    } catch (error) {
      if (error instanceof AppServerOperationError) throw error;
      if (isDomainError(error)) {
        const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status >= 500 ? "server_unavailable" : "invalid_request";
        throw new AppServerOperationError(error.status, code, error.message, error.code, error.retryable, correlationId);
      }
      // Connection errors must not expose provider payloads, secrets or paths.
      throw new AppServerOperationError(503, "server_unavailable", "Harness operation is unavailable", "HARNESS_UNAVAILABLE", false, correlationId);
    }
  };
  return {
    setup: (params) => operation(params, (context) => service.setup(context, params)),
    status: (params) => operation(params, (context) => service.status(context, params)),
    models: (params) => operation(params, (context) => service.models(context, params)),
    readSelection: (params) => operation(params, (context) => service.readSelection(context, params)),
    select: (params) => operation(params, (context) => service.select(context, params)),
  };
}
