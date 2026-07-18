import type { AppendRunEventInput } from "../runs/types.js";
import type { SessionRecord } from "../sessions/types.js";

export interface PersistAutomatedThreadTitleInput {
  userId: string;
  sessionId: string;
  title: string;
  titleSource: "preview" | "generated";
  expectedTitleVersion?: number;
  initialOnly?: boolean;
  buildEvent(session: SessionRecord): AppendRunEventInput;
}

/**
 * Atomic persistence boundary for the session title projection and the
 * canonical run event that makes that projection replayable.
 */
export interface ThreadTitleRepository {
  persistAutomatedTitle(
    input: PersistAutomatedThreadTitleInput,
  ): Promise<SessionRecord | null>;
}
