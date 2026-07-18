import {
  ThreadTitleUpdatedPayloadSchema,
} from "@repo/platform-protocol";
import type { SessionRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { buildThreadTitlePreview } from "./ThreadTitlePreview";
import { withThreadTitleRepository } from "./ThreadTitlePersistenceFactory";

type AutomatedThreadTitleSource = "preview" | "generated";

export interface PersistThreadTitleInput {
  sessionId: string;
  threadId: string;
  runId: string;
  userId: string;
  firstMessageId: string;
  title: string;
  source: AutomatedThreadTitleSource;
  expectedTitleVersion?: number;
  initialOnly?: boolean;
}

/**
 * Owns the server-side session projection and its corresponding canonical run
 * event. Browser clients render the projection; they never select a title.
 */
export class ThreadTitleService {
  constructor(private readonly env: Env) {}

  async persistPreview(
    input: Omit<PersistThreadTitleInput, "title" | "source"> & {
      prompt: string;
    },
  ): Promise<SessionRecord | null> {
    return await this.persist({
      ...input,
      title: buildThreadTitlePreview(input.prompt),
      source: "preview",
      initialOnly: true,
    });
  }

  async persist(input: PersistThreadTitleInput): Promise<SessionRecord | null> {
    return await withThreadTitleRepository(this.env, (repository) =>
      repository.persistAutomatedTitle({
        userId: input.userId,
        sessionId: input.sessionId,
        title: input.title,
        titleSource: input.source,
        expectedTitleVersion: input.expectedTitleVersion,
        initialOnly: input.initialOnly,
        buildEvent: (session) => {
          const payload = ThreadTitleUpdatedPayloadSchema.parse({
            threadId: input.threadId,
            firstMessageId: input.firstMessageId,
            title: session.title,
            titleVersion: session.titleVersion ?? 1,
            source: input.source,
            timestamp: session.updatedAt,
          });
          return {
            runId: input.runId,
            sessionId: input.sessionId,
            eventType: "thread.title.updated",
            payload,
            idempotencyKey: `thread-title:${input.threadId}:${input.firstMessageId}:${input.source}:${payload.titleVersion}`,
          };
        },
      }),
    );
  }
}
