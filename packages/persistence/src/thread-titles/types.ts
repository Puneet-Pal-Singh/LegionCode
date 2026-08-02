import type { AppendEventInput } from "@repo/event-store";
import type { SessionRecord } from "../sessions/types.js";

export interface PersistThreadTitleInput {
  userId: string;
  sessionId: string;
  title: string;
  titleSource: "preview" | "generated" | "user";
  expectedTitleVersion?: number;
  initialOnly?: boolean;
  buildEvent(session: SessionRecord): AppendEventInput;
}

/**
 * Atomic persistence boundary for the session title projection and its
 * canonical, thread-scoped platform event. Run events are deliberately not a
 * title transport: a title belongs to a thread, not a run projection.
 */
export interface ThreadTitleRepository {
  persistTitle(
    input: PersistThreadTitleInput,
  ): Promise<SessionRecord | null>;
}
