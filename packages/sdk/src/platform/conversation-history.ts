import {
  ConversationHistoryResponseSchema,
  type ConversationHistoryMessage,
} from "@repo/platform-protocol";

/**
 * Session transcript replay shared by clients. Cursor and snapshot are decimal
 * safe integers; cursors advance strictly and cannot cross the snapshot.
 */
export interface ConversationHistoryPage<TMessage> {
  messages: TMessage[];
  nextCursor: string | null;
  snapshot: string;
}

/** Validate an untrusted HTTP page against the shared protocol contract. */
export function parseConversationHistoryPage(value: unknown): ConversationHistoryPage<ConversationHistoryMessage> {
  const parsed = ConversationHistoryResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("History response failed the shared conversation-history contract");
  return parsed.data;
}

export interface ConversationHistoryReadOptions {
  signal?: AbortSignal;
  pageSize?: number;
}

export interface ConversationHistoryReadResult<TMessage> {
  messages: TMessage[];
  snapshot: string;
}

export class ConversationHistoryReadError extends Error {
  readonly messages: readonly unknown[];
  readonly snapshot: string | null;

  constructor(
    message: string,
    messages: readonly unknown[] = [],
    snapshot: string | null = null,
  ) {
    super(message);
    this.name = "ConversationHistoryReadError";
    this.messages = messages;
    this.snapshot = snapshot;
  }
}

export async function readConversationHistory<TMessage>(
  readPage: (
    cursor: string | null,
    snapshot: string | null,
    signal?: AbortSignal,
  ) => Promise<ConversationHistoryPage<TMessage>>,
  options: ConversationHistoryReadOptions = {},
): Promise<ConversationHistoryReadResult<TMessage>> {
  const messages: TMessage[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let snapshot: string | null = null;
  while (true) {
    if (options.signal?.aborted) {
      throw new ConversationHistoryReadError(
        "Conversation history read was cancelled",
        messages,
        snapshot,
      );
    }
    let page: ConversationHistoryPage<TMessage>;
    try {
      page = await readPage(cursor, snapshot, options.signal);
    } catch (error) {
      if (error instanceof ConversationHistoryReadError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConversationHistoryReadError(reason, messages, snapshot);
    }

    if (!page.snapshot || typeof page.snapshot !== "string") {
      throw new ConversationHistoryReadError(
        "History response is missing its snapshot watermark",
        messages,
        snapshot,
      );
    }
    const snapshotValue = Number(page.snapshot);
    if (!/^\d+$/.test(page.snapshot) || !Number.isSafeInteger(snapshotValue)) {
      throw new ConversationHistoryReadError(
        "History response contains an invalid snapshot watermark",
        messages,
        snapshot,
      );
    }
    if (snapshot !== null && page.snapshot !== snapshot) {
      throw new ConversationHistoryReadError(
        "History snapshot changed during pagination",
        messages,
        snapshot,
      );
    }
    snapshot ??= page.snapshot;
    if (!Array.isArray(page.messages)) {
      throw new ConversationHistoryReadError(
        "History response contains an invalid message page",
        messages,
        snapshot,
      );
    }
    if (page.nextCursor === null) {
      messages.push(...page.messages);
      return { messages, snapshot };
    }
    if (
      typeof page.nextCursor !== "string" ||
      page.nextCursor.length === 0 ||
      !/^\d+$/.test(page.nextCursor) ||
      !Number.isSafeInteger(Number(page.nextCursor)) ||
      Number(page.nextCursor) <= (cursor === null ? -1 : Number(cursor)) ||
      Number(page.nextCursor) > snapshotValue ||
      seenCursors.has(page.nextCursor) ||
      page.nextCursor === cursor
    ) {
      throw new ConversationHistoryReadError(
        "History pagination cursor did not make progress",
        messages,
        snapshot,
      );
    }
    messages.push(...page.messages);
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
