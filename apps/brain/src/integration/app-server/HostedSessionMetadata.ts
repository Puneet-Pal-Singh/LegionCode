import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import type { SessionRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";
import { readPersistedThreadTitleScope, ThreadTitleService } from "../../services/thread-titles";
import { createPersistedSession } from "./HostedSessionCreation";

/** Bound only to a cookie-verified principal by the hosted controller. */
export function composeHostedSessionMetadata(
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["sessionMetadataService"]> {
  const mutate = async (operation: "pinSession" | "unpinSession" | "archiveSession" | "unarchiveSession", sessionId: string) => {
    const session = await withTranscriptRepository(env, (repository) => repository[operation](userId, sessionId));
    return { session: requireSession(session) };
  };
  return {
    list: () => unavailableOnFailure(() => withTranscriptRepository(env, (repository) => repository.listSessions(userId))),
    listArchived: () => unavailableOnFailure(async () => ({ sessions: await withTranscriptRepository(env, (repository) => repository.listArchivedSessions(userId)) })),
    create: (params) => unavailableOnFailure(async () => {
      if (params.workspaceId !== undefined) {
        const authorized = await withWorkspaceRepository(env, async (repository) =>
          (await repository.listWorkspaces(userId)).some(({ workspace }) => workspace.id === params.workspaceId && workspace.status === "active"),
        );
        if (!authorized) throw new AppServerOperationError(404, "not_found", "Workspace not found");
      }
      return { session: await createPersistedSession(params, userId, env) };
    }),
    rename: (params) => unavailableOnFailure(async () => {
      const titleScope = await readPersistedThreadTitleScope(env, userId, params.sessionId);
      if (!titleScope) throw new AppServerOperationError(409, "TITLE_SCOPE_UNAVAILABLE", "This task has no canonical title scope yet.");
      const session = await new ThreadTitleService(env).rename({
        sessionId: params.sessionId, ...titleScope, userId, title: params.title,
      });
      return { session: requireSession(session) };
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
