import type { RunRepository } from "../runs/types.js";
import type { SessionRecord, TranscriptRepository } from "../sessions/types.js";
import type {
  PersistAutomatedThreadTitleInput,
  ThreadTitleRepository,
} from "./types.js";

/** Memory implementation mirrors the database transaction for boundary tests. */
export class MemoryThreadTitleRepository implements ThreadTitleRepository {
  constructor(
    private readonly transcripts: TranscriptRepository,
    private readonly runs: RunRepository,
  ) {}

  async persistAutomatedTitle(
    input: PersistAutomatedThreadTitleInput,
  ): Promise<SessionRecord | null> {
    return await this.transcripts.transaction(async (transcripts) =>
      this.runs.transaction(async (runs) => {
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

        await runs.appendEvent(input.buildEvent(session));
        return session;
      }),
    );
  }
}
