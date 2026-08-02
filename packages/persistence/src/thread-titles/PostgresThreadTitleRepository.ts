import { PostgresEventStore } from "../canonical-events/PostgresEventStore.js";
import type { SqlClient } from "../sql.js";
import { PostgresTranscriptRepository } from "../sessions/PostgresTranscriptRepository.js";
import type { SessionRecord } from "../sessions/types.js";
import type {
  PersistThreadTitleInput,
  ThreadTitleRepository,
} from "./types.js";

export class PostgresThreadTitleRepository implements ThreadTitleRepository {
  constructor(private readonly client: SqlClient) {}

  async persistTitle(
    input: PersistThreadTitleInput,
  ): Promise<SessionRecord | null> {
    return await this.client.transaction(async (transaction) => {
      const transcripts = new PostgresTranscriptRepository(transaction);
      const session =
        input.titleSource === "user"
          ? await transcripts.renameSessionTitle({
              userId: input.userId,
              sessionId: input.sessionId,
              title: input.title,
              titleSource: "user",
            })
          : await transcripts.updateAutomatedSessionTitle({
              userId: input.userId,
              sessionId: input.sessionId,
              title: input.title,
              titleSource: input.titleSource,
              expectedTitleVersion: input.expectedTitleVersion,
              initialOnly: input.initialOnly,
            });
      if (!session) {
        return null;
      }

      await new PostgresEventStore(transaction).append(input.buildEvent(session));
      return session;
    });
  }
}
