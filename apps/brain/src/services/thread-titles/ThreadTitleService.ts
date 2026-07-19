import {
  EVENT_SCHEMA_VERSION,
  RunIdSchema,
  ThreadIdSchema,
  ThreadTitleUpdatedPayloadSchema,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type {
  PersistThreadTitleInput as PersistThreadTitleRepositoryInput,
  SessionRecord,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { buildThreadTitlePreview } from "./ThreadTitlePreview";
import { withThreadTitleRepository } from "./ThreadTitlePersistenceFactory";

type AutomatedThreadTitleSource = "preview" | "generated";
type ThreadTitleEventInput = Extract<
  ReturnType<PersistThreadTitleRepositoryInput["buildEvent"]>,
  { type: "thread.title.updated" }
>;

export interface PersistThreadTitleInput {
  sessionId: string;
  threadId: string;
  runId: string;
  workspaceId: string;
  userId: string;
  firstMessageId: string;
  title: string;
  source: AutomatedThreadTitleSource;
  expectedTitleVersion?: number;
  initialOnly?: boolean;
}

/**
 * Owns the server-side session projection and its matching canonical thread
 * event. Browser clients render those server-owned records; they never select
 * a title or synthesize title lifecycle.
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
      repository.persistTitle({
        userId: input.userId,
        sessionId: input.sessionId,
        title: input.title,
        titleSource: input.source,
        expectedTitleVersion: input.expectedTitleVersion,
        initialOnly: input.initialOnly,
        buildEvent: (session) => this.buildEvent(input, session, input.source),
      }),
    );
  }

  async rename(
    input: Omit<PersistThreadTitleInput, "source">,
  ): Promise<SessionRecord | null> {
    return await withThreadTitleRepository(this.env, (repository) =>
      repository.persistTitle({
        userId: input.userId,
        sessionId: input.sessionId,
        title: input.title,
        titleSource: "user",
        buildEvent: (session) => this.buildEvent(input, session, "user"),
      }),
    );
  }

  private buildEvent(
    input: PersistThreadTitleInput | Omit<PersistThreadTitleInput, "source">,
    session: SessionRecord,
    source: "preview" | "generated" | "user",
  ): ThreadTitleEventInput {
    const threadId = ThreadIdSchema.parse(input.threadId);
    const payload = ThreadTitleUpdatedPayloadSchema.parse({
      threadId,
      firstMessageId: input.firstMessageId,
      title: session.title,
      titleVersion: session.titleVersion ?? 1,
      source,
      timestamp: session.updatedAt,
    });

    return {
      runId: RunIdSchema.parse(input.runId),
      scopeType: "thread",
      scopeId: threadId,
      threadId,
      workspaceId: workspaceIdFromExternalId(input.workspaceId),
      type: "thread.title.updated",
      payload,
      idempotencyKey: `thread-title:${threadId}:${input.firstMessageId}:${source}:${payload.titleVersion}`,
      producer: { kind: "control_plane", id: "thread-title-service" },
      schemaVersion: EVENT_SCHEMA_VERSION,
    };
  }
}
