import type { SqlClient } from "../sql.js";
import { PostgresRunRepository } from "../runs/PostgresRunRepository.js";
import { PostgresTranscriptRepository } from "../sessions/PostgresTranscriptRepository.js";
import type { SessionRecord } from "../sessions/types.js";
import type {
  PersistAutomatedThreadTitleInput,
  ThreadTitleRepository,
} from "./types.js";

export class PostgresThreadTitleRepository implements ThreadTitleRepository {
  constructor(private readonly client: SqlClient) {}

  async persistAutomatedTitle(
    input: PersistAutomatedThreadTitleInput,
  ): Promise<SessionRecord | null> {
    return await this.client.transaction(async (transaction) => {
      const transcripts = new PostgresTranscriptRepository(transaction);
      const session = await transcripts.updateAutomatedSessionTitle({
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

      await new PostgresRunRepository(transaction).appendEvent(
        input.buildEvent(session),
      );
      return session;
    });
  }
}
