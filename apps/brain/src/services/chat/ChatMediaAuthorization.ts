import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";

/** Reuses authenticated transcript membership for durable chat media access. */
export async function ownsChatMediaSession(
  env: Env,
  userId: string,
  sessionId: string,
  expectedWorkspaceId?: string,
): Promise<boolean> {
  return await withTranscriptRepository(env, async (repository) => {
    const active = await repository.listSessions(userId);
    const session = active.sessions.find((session) => session.id === sessionId);
    if (session) return expectedWorkspaceId === undefined || session.workspaceId === expectedWorkspaceId;
    const archived = await repository.listArchivedSessions(userId);
    return archived.some((session) => session.id === sessionId &&
      (expectedWorkspaceId === undefined || session.workspaceId === expectedWorkspaceId));
  });
}
