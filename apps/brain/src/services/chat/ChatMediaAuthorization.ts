import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";

/** Reuses authenticated transcript membership for durable chat media access. */
export async function ownsChatMediaSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  return await withTranscriptRepository(env, async (repository) => {
    const active = await repository.listSessions(userId);
    if (active.sessions.some((session) => session.id === sessionId)) return true;
    const archived = await repository.listArchivedSessions(userId);
    return archived.some((session) => session.id === sessionId);
  });
}
