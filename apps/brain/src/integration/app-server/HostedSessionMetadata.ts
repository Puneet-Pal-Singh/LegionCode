import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import { SessionReadReceiptError, type SessionRecord } from "@repo/persistence";
import type { HostedSessionWorkspaceContextRequest } from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withSessionReadReceiptRepository } from "../../services/sessions/SessionReadReceiptPersistenceFactory";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";
import { readPersistedThreadTitleScope, ThreadTitleService } from "../../services/thread-titles";
import { createPersistedSession } from "./HostedSessionCreation";

/** Bound only to a cookie-verified principal by the hosted controller. */
export function composeHostedSessionMetadata(
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["sessionMetadataService"]> {
  const withReadState = async (session: SessionRecord | null): Promise<SessionRecord> => {
    const required = requireSession(session);
    return (await attachReadStates(env, userId, [required]))[0]!;
  };
  const mutate = async (operation: "pinSession" | "unpinSession" | "archiveSession" | "unarchiveSession", sessionId: string) => {
    const session = await withTranscriptRepository(env, (repository) => repository[operation](userId, sessionId));
    return { session: await withReadState(session) };
  };
  return {
    list: () => unavailableOnFailure(async () => {
      const listed = await withTranscriptRepository(env, (repository) => repository.listSessions(userId));
      return { ...listed, sessions: await attachReadStates(env, userId, listed.sessions) };
    }),
    listArchived: () => unavailableOnFailure(async () => {
      const sessions = await withTranscriptRepository(env, (repository) => repository.listArchivedSessions(userId));
      return { sessions: await attachReadStates(env, userId, sessions) };
    }),
    workspaceContext: (params) => unavailableOnFailure(() => readWorkspaceContext(env, userId, params)),
    readReceipt: (params) => unavailableOnFailure(async () => {
      try {
        const receipt = await withSessionReadReceiptRepository(env, (repository) => repository.acknowledge({
          sessionId: params.sessionId,
          viewerId: userId,
          terminalTurnId: params.terminalTurnId,
          acknowledgedAt: new Date().toISOString(),
        }));
        return {
          sessionId: receipt.sessionId,
          lastAcknowledgedTerminalTurnId: receipt.lastAcknowledgedTerminalTurnId,
          acknowledgedAt: receipt.acknowledgedAt,
        };
      } catch (error) {
        if (error instanceof SessionReadReceiptError) {
          throw new AppServerOperationError(
            error.code === "session_not_found" ? 404 : 409,
            error.code === "session_not_found" ? "not_found" : "conflict",
            error.message,
          );
        }
        throw error;
      }
    }),
    create: (params) => unavailableOnFailure(async () => {
      if (params.workspaceId !== undefined) {
        const authorized = await withWorkspaceRepository(env, async (repository) =>
          (await repository.listWorkspaces(userId)).some(({ workspace }) => workspace.id === params.workspaceId && workspace.status === "active"),
        );
        if (!authorized) throw new AppServerOperationError(404, "not_found", "Workspace not found");
      }
      return { session: await withReadState(await createPersistedSession(params, userId, env)) };
    }),
    rename: (params) => unavailableOnFailure(async () => {
      const titleScope = await readPersistedThreadTitleScope(env, userId, params.sessionId);
      if (!titleScope) throw new AppServerOperationError(409, "TITLE_SCOPE_UNAVAILABLE", "This task has no canonical title scope yet.");
      const session = await new ThreadTitleService(env).rename({
        sessionId: params.sessionId, ...titleScope, userId, title: params.title,
      });
      return { session: await withReadState(session) };
    }),
    pin: (sessionId) => unavailableOnFailure(() => mutate("pinSession", sessionId)),
    unpin: (sessionId) => unavailableOnFailure(() => mutate("unpinSession", sessionId)),
    archive: (sessionId) => unavailableOnFailure(() => mutate("archiveSession", sessionId)),
    unarchive: (sessionId) => unavailableOnFailure(() => mutate("unarchiveSession", sessionId)),
    deleteArchived: (sessionId) => unavailableOnFailure(async () => {
      const deleted = await withTranscriptRepository(env, (repository) => repository.deleteArchivedSession(userId, sessionId));
      if (!deleted) throw new AppServerOperationError(404, "not_found", "Archived session not found");
      return { deleted: true as const };
    }),
  };
}

async function readWorkspaceContext(
  env: Env,
  userId: string,
  params: HostedSessionWorkspaceContextRequest,
) {
  const session = await withTranscriptRepository(env, async (repository) => {
    const active = (await repository.listSessions(userId)).sessions.find(
      (candidate) => candidate.id === params.sessionId,
    );
    if (active) return active;
    return (await repository.listArchivedSessions(userId)).find(
      (candidate) => candidate.id === params.sessionId,
    ) ?? null;
  });
  if (!session || session.userId !== userId) {
    throw new AppServerOperationError(404, "not_found", "Session not found");
  }

  const runId = params.runId ?? session.activeRunId ?? session.latestRunId ?? null;
  const run = runId
    ? await withRunRepository(env, (repository) => repository.getRun(runId, userId))
    : null;
  if (run && run.sessionId !== session.id) {
    throw new AppServerOperationError(404, "not_found", "Session run not found");
  }
  if (run?.workspaceId && session.workspaceId && run.workspaceId !== session.workspaceId) {
    throw new AppServerOperationError(404, "not_found", "Session workspace context not found");
  }

  const workspaceId = run?.workspaceId ?? session.workspaceId;
  const workspaces = await withWorkspaceRepository(env, (repository) =>
    repository.listWorkspaces(userId),
  );
  const boundWorkspace = workspaceId
    ? workspaces.find(({ workspace }) => workspace.id === workspaceId && workspace.userId === userId)
    : undefined;
  if (workspaceId && !boundWorkspace) {
    throw new AppServerOperationError(404, "not_found", "Session workspace context not found");
  }
  const legacyMatches = !workspaceId && session.repository
    ? workspaces.filter(({ repository }) => repository.fullName === session.repository)
    : [];
  const displayWorkspace = boundWorkspace ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined);
  const repository = displayWorkspace?.repository ?? null;
  const selectedBranch = run?.branch?.trim() || (
    displayWorkspace?.workspace.lastSelectedBranch ||
    displayWorkspace?.workspace.defaultBranch ||
    displayWorkspace?.repository.defaultBranch ||
    null
  );

  return {
    sessionId: session.id,
    workspaceId,
    threadId: session.threadId,
    repository,
    selectedBranch,
  };
}

async function attachReadStates(
  env: Env,
  userId: string,
  sessions: SessionRecord[],
): Promise<SessionRecord[]> {
  const states = await withSessionReadReceiptRepository(env, (repository) =>
    repository.listReadStates(userId, sessions.map(({ id }) => id)),
  );
  const bySession = new Map(states.map((state) => [state.sessionId, state]));
  return sessions.map((session) => {
    const state = bySession.get(session.id);
    return {
      ...session,
      lastTerminalTurnId: state?.lastTerminalTurnId ?? null,
      lastAcknowledgedTerminalTurnId: state?.lastAcknowledgedTerminalTurnId ?? null,
    };
  });
}

function requireSession(session: SessionRecord | null): SessionRecord {
  if (!session) throw new AppServerOperationError(404, "not_found", "Session not found");
  return session;
}

async function unavailableOnFailure<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    throw new AppServerOperationError(503, "server_unavailable", "Session metadata is unavailable");
  }
}
