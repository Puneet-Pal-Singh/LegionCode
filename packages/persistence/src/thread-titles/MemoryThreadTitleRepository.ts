import type { EventStore } from "@repo/event-store";
import type { SessionRecord, TranscriptRepository } from "../sessions/types.js";
import type {
  PersistThreadTitleInput,
  ThreadTitleRepository,
} from "./types.js";

/** Memory implementation keeps the same canonical event contract as Postgres. */
export class MemoryThreadTitleRepository implements ThreadTitleRepository {
  constructor(
    private readonly transcripts: TranscriptRepository,
    private readonly events: EventStore,
  ) {}

  async persistTitle(
    input: PersistThreadTitleInput,
  ): Promise<SessionRecord | null> {
    return await this.transcripts.transaction(async (transcripts) => {
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

      await this.events.append(input.buildEvent(session));
      return session;
    });
  }
}
