import { RunIdSchema, type RunId } from "@repo/platform-protocol";
import { AppServerProviderOperationError } from "@legioncode/app-server/server";
import { parseProviderAuthScopeRequest, type AuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import {
  DomainError,
  isDomainError,
  toNormalizedProviderError,
} from "../../domain/errors";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";
import type { Env } from "../../types/ai";

/** Bind hosted provider operations to the authenticated run/session/workspace records. */
export function createHostedProviderOperation(
  request: Request,
  env: Env,
  userId: string,
) {
  return async <T>(
    runId: string,
    action: (
      scope: AuthorizedProviderScope,
      correlationId: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveHostedProviderScope(
        request,
        env,
        userId,
        correlationId,
        RunIdSchema.parse(runId),
      );
      return await action(scope, correlationId);
    } catch (error) {
      throw new AppServerProviderOperationError(
        isDomainError(error) ? error.status : 500,
        toNormalizedProviderError(error, correlationId),
      );
    }
  };
}

async function resolveHostedProviderScope(
  request: Request,
  env: Env,
  userId: string,
  correlationId: string,
  runId: RunId,
): Promise<AuthorizedProviderScope> {
  const parsed = parseProviderAuthScopeRequest(request, correlationId, runId);
  if (parsed.requestedUserId && parsed.requestedUserId !== userId) {
    throw unauthorized(correlationId);
  }

  const run = await readScopeRepository(correlationId, () =>
    withRunRepository(env, (repository) => repository.getRun(parsed.runId)),
  );

  let boundWorkspaceId: string | null = null;
  if (run) {
    if (run.userId !== userId) throw unauthorized(correlationId);

    const session = await readScopeRepository(correlationId, () =>
      withTranscriptRepository(env, async (repository) => {
        const active = (await repository.listSessions(userId)).sessions.find(
          (candidate) => candidate.id === run.sessionId,
        );
        if (active) return active;
        return (await repository.listArchivedSessions(userId)).find(
          (candidate) => candidate.id === run.sessionId,
        ) ?? null;
      }),
    );
    if (!session || session.userId !== userId) throw unauthorized(correlationId);

    if (
      run.workspaceId && session.workspaceId &&
      run.workspaceId !== session.workspaceId
    ) {
      throw unauthorized(correlationId);
    }
    boundWorkspaceId = run.workspaceId ?? session.workspaceId;
  }

  const workspaceId = boundWorkspaceId ?? await readCurrentWorkspaceSelection(
    env,
    userId,
    correlationId,
  );
  if (parsed.requestedWorkspaceId && parsed.requestedWorkspaceId !== workspaceId) {
    throw unauthorized(correlationId);
  }

  const workspaceIsOwnedAndActive = await readScopeRepository(correlationId, () =>
    withWorkspaceRepository(env, async (repository) =>
      (await repository.listWorkspaces(userId)).some(
        ({ workspace }) =>
          workspace.id === workspaceId &&
          workspace.userId === userId &&
          workspace.status === "active",
      ),
    ),
  );
  if (!workspaceIsOwnedAndActive) throw unauthorized(correlationId);

  return { runId: parsed.runId, userId, workspaceId };
}

async function readCurrentWorkspaceSelection(
  env: Env,
  userId: string,
  correlationId: string,
): Promise<string> {
  const selection = await readScopeRepository(correlationId, () =>
    withWorkspaceRepository(env, (repository) => repository.findWorkspaceSelection(userId)),
  );
  if (
    !selection ||
    selection.selection.userId !== userId ||
    selection.selection.selectedWorkspaceId !== selection.workspace.id ||
    selection.workspace.userId !== userId ||
    selection.workspace.status !== "active"
  ) {
    throw unauthorized(correlationId);
  }
  return selection.workspace.id;
}

async function readScopeRepository<T>(
  correlationId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch {
    throw new DomainError(
      "PROVIDER_UNAVAILABLE",
      "Provider resource scope is temporarily unavailable. Please retry.",
      503,
      true,
      correlationId,
    );
  }
}

function unauthorized(correlationId: string): DomainError {
  return new DomainError(
    "AUTH_FAILED",
    "Provider resource scope is not authorized for this account.",
    403,
    false,
    correlationId,
  );
}
