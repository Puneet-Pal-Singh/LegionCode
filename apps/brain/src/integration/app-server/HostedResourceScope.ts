import type { RunId } from "@repo/platform-protocol";
import { parseProviderAuthScopeRequest, type AuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import { DomainError } from "../../domain/errors";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";
import type { Env } from "../../types/ai";

/** Authorize the persisted conversation/run workspace; current selection is only for unbound setup. */
export async function resolveHostedResourceScope(
  request: Request,
  env: Env,
  userId: string,
  correlationId: string,
  runId: RunId | undefined,
  sessionId?: string,
): Promise<AuthorizedProviderScope> {
  const parsed = parseProviderAuthScopeRequest(request, correlationId, runId);
  if (parsed.requestedUserId && parsed.requestedUserId !== userId) {
    throw unauthorized(correlationId);
  }

  const run =
    parsed.runId === undefined
      ? null
      : await readScopeRepository(correlationId, () =>
          withRunRepository(env, (repository) =>
            repository.getRun(parsed.runId!),
          ),
        );

  // Only turn admission with an existing owned session may introduce a new run.
  // Provider/checkout/input reads must never turn a missing or foreign run into setup.
  if (parsed.runId !== undefined && !run && !sessionId) throw unauthorized(correlationId);

  let boundWorkspaceId: string | null = null;
  if (run || sessionId) {
    if (run && (run.userId !== userId || (sessionId && run.sessionId !== sessionId)))
      throw unauthorized(correlationId);
    const ownedSessionId = sessionId ?? run!.sessionId;

    const session = await readScopeRepository(correlationId, () =>
      withTranscriptRepository(env, async (repository) => {
        const active = (await repository.listSessions(userId)).sessions.find(
          (candidate) => candidate.id === ownedSessionId,
        );
        if (active) return active;
        return (
          (await repository.listArchivedSessions(userId)).find(
            (candidate) => candidate.id === ownedSessionId,
          ) ?? null
        );
      }),
    );
    if (!session || session.userId !== userId) {
      if (sessionId) throw new DomainError("SESSION_NOT_FOUND", "Conversation not found", 404, false, correlationId);
      throw unauthorized(correlationId);
    }

    if (
      run?.workspaceId &&
      session.workspaceId &&
      run.workspaceId !== session.workspaceId
    ) {
      if (sessionId) throw new DomainError("TURN_SCOPE_MISMATCH", "Conversation workspace does not match its run", 409, false, correlationId);
      throw unauthorized(correlationId);
    }
    boundWorkspaceId = run?.workspaceId ?? session.workspaceId;
    if (!boundWorkspaceId && sessionId && parsed.runId) {
      const admission = await readScopeRepository(correlationId, () =>
        withTurnAdmissionRepository(env, (repository) =>
          repository.getBySessionAndRunId(sessionId, parsed.runId!),
        ),
      );
      if (admission) {
        if (admission.userId !== userId || admission.sessionId !== sessionId || admission.runId !== parsed.runId) {
          throw unauthorized(correlationId);
        }
        boundWorkspaceId = admission.workspaceId;
      }
    }
    if (!boundWorkspaceId && !sessionId) throw unauthorized(correlationId);
  }

  const workspaceId =
    boundWorkspaceId ??
    (await readCurrentWorkspaceSelection(env, userId, correlationId));
  if (
    parsed.requestedWorkspaceId &&
    parsed.requestedWorkspaceId !== workspaceId
  ) {
    throw unauthorized(correlationId);
  }

  const workspaceIsOwnedAndActive = await readScopeRepository(
    correlationId,
    () =>
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

  return {
    ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
    userId,
    workspaceId,
  };
}

async function readCurrentWorkspaceSelection(
  env: Env,
  userId: string,
  correlationId: string,
): Promise<string> {
  const selection = await readScopeRepository(correlationId, () =>
    withWorkspaceRepository(env, (repository) =>
      repository.findWorkspaceSelection(userId),
    ),
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
