import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";

export interface PersistedThreadTitleScope {
  threadId: string;
  runId: string;
  workspaceId: string;
  firstMessageId: string;
}

/** Resolves only server-persisted identity required for a title mutation. */
export async function readPersistedThreadTitleScope(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<PersistedThreadTitleScope | null> {
  return await withTranscriptRepository(env, async (repository) => {
    const session = (await repository.listSessions(userId)).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (
      !session?.threadId ||
      !session.activeRunId ||
      !session.workspaceId
    ) {
      return null;
    }

    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await repository.listTranscript({
        sessionId,
        userId,
        cursor,
        limit: 100,
      });
      const firstUserMessage = page.messages.find(
        (message) => message.role === "user",
      );
      if (firstUserMessage) {
        return {
          threadId: session.threadId,
          runId: session.activeRunId,
          workspaceId: session.workspaceId,
          firstMessageId: firstUserMessage.id,
        };
      }
      cursor = page.nextCursor;
    }

    return null;
  });
}
