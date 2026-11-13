import {
  LocalThreadHistoryParamsSchema,
  LocalThreadHistoryResultSchema,
  type LocalThreadHistoryParams,
  type LocalThreadHistoryResult,
  type LocalThreadHistoryMessagesWindow,
} from "@legioncode/app-server/protocol";
import {
  EventCursorSchema,
  EventIdSchema,
  EventSequenceSchema,
  ChatImageAttachmentRefSchema,
  ItemIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES,
  APP_SERVER_PROTOCOL_VERSION,
  appServerJsonByteLength,
} from "@repo/platform-protocol";
import { z } from "zod";

const MessageIdentitySchema = z.object({
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  inputId: z.string().uuid().optional(),
  acceptedSequence: EventSequenceSchema.optional(),
}).passthrough();
const MessageMetadataSchema = z.object({
  canonicalIdentity: MessageIdentitySchema,
  eventCursor: EventCursorSchema,
  eventId: EventIdSchema,
  eventSequence: EventSequenceSchema,
  transcriptMessageId: z.string().min(1),
  imageAttachments: z.array(ChatImageAttachmentRefSchema).max(8).optional(),
}).passthrough();

export interface LocalThreadHistoryReadOptions {
  signal?: AbortSignal;
  /** Bound cursor-cycle tracking; callers may resume from a yielded continuation. */
  maxPages?: number;
}

/** Yield bounded canonical user-message pages. The caller owns which page to
 * retain; this iterator never concatenates messages or drains ahead of demand.
 * Aborting a read fences its result, not the underlying execution resource. */
export async function* iterateLocalThreadHistory(
  readPage: (params: LocalThreadHistoryParams, signal?: AbortSignal) => Promise<LocalThreadHistoryResult>,
  input: LocalThreadHistoryParams,
  options: LocalThreadHistoryReadOptions = {},
): AsyncGenerator<LocalThreadHistoryResult, void, void> {
  let params = LocalThreadHistoryParamsSchema.parse(input);
  const maxPages = z.number().int().min(1).max(1_000).parse(options.maxPages ?? 1_000);
  const attempts = new Map<string, string>();
  const seenCursors = new Set<string>();
  let snapshot: LocalThreadHistoryMessagesWindow | undefined;
  let count = 0;
  for (;;) {
    assertNotAborted(options.signal);
    if (count++ >= maxPages) throw new Error("Local history page limit reached; resume from the last yielded continuation");
    const requested = params.messagesContinuation;
    const direction = requested?.direction ?? (params.latest ? "backward" : "forward");
    if (requested?.cursor !== null && requested?.cursor !== undefined) seenCursors.add(requested.cursor);
    const page = LocalThreadHistoryResultSchema.parse(await readPage(LocalThreadHistoryParamsSchema.parse(params), options.signal));
    assertNotAborted(options.signal);
    if (requested && (page.admissions.length || page.nextCursor !== null || page.hasEarlier !== undefined)) {
      throw new Error("Local message continuation changed its admission page");
    }
    for (const admission of page.admissions) {
      if (admission.run.workspaceId !== params.workspaceId || admission.run.threadId !== params.threadId ||
          admission.turn.threadId !== params.threadId || admission.turn.runId !== admission.run.id ||
          admission.userMessage.turnId !== admission.turn.id || admission.userMessage.threadId !== params.threadId ||
          admission.userMessage.runId !== admission.run.id) throw new Error("Local history admission scope changed");
      attempts.set(admission.turn.id, admission.runAttemptId);
    }
    const window = page.messagesWindow;
    if (!window) {
      if (requested || page.admissions.length) throw new Error("Local history is missing its message snapshot");
    } else {
      const expectedTurns = requested?.turnIds ?? page.admissions.map((admission) => admission.turn.id);
      if (!sameValues(window.turnIds, expectedTurns) ||
          (requested && window.throughCursor !== requested.throughCursor) ||
          (snapshot && (window.throughCursor !== snapshot.throughCursor ||
            !sameValues(window.turnIds, snapshot.turnIds) ||
            JSON.stringify(window.lastUserByTurn) !== JSON.stringify(snapshot.lastUserByTurn)))) {
        throw new Error("Local history snapshot changed during pagination");
      }
      snapshot ??= { ...window, turnIds: [...window.turnIds], lastUserByTurn: window.lastUserByTurn.map((last) => ({ ...last })) };
      if (page.messages.length > (params.messageLimit ?? 100) || (requested && page.messages.length === 0)) {
        throw new Error("Local history message window did not make progress");
      }
      const bodyCursors = new Set<string>();
      const bodyIds = new Set<string>();
      for (const message of page.messages) {
        const metadata = MessageMetadataSchema.parse(message.data?.metadata);
        const identity = metadata.canonicalIdentity;
        const cursor = metadata.eventCursor;
        ItemIdSchema.parse(message.id);
        if (message.role !== "user" || identity.threadId !== params.threadId ||
            !window.turnIds.includes(identity.turnId) ||
            (attempts.has(identity.turnId) && attempts.get(identity.turnId) !== identity.runAttemptId) ||
            bodyCursors.has(cursor) || bodyIds.has(message.id) || cursor === requested?.cursor) {
          throw new Error("Local history message scope or cursor changed");
        }
        bodyCursors.add(cursor);
        bodyIds.add(message.id);
      }
      if (page.messages.length && (page.messages[0]?.data?.metadata?.eventCursor !== window.firstCursor ||
          page.messages.at(-1)?.data?.metadata?.eventCursor !== window.lastCursor)) {
        throw new Error("Local history message cursors do not match their window");
      }
      const more = direction === "forward" ? window.hasLater : window.hasEarlier;
      if (more !== Boolean(page.messagesContinuation) ||
          (page.messagesContinuation && page.messagesContinuation.direction !== direction)) {
        throw new Error("Local history continuation direction changed");
      }
    }
    if (appServerJsonByteLength({ protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "thread/history", ok: true, result: page }) > APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES) {
      throw new Error("Local history response exceeds the supported byte budget");
    }
    const continuation = page.messagesContinuation;
    if (continuation?.cursor !== null && continuation?.cursor !== undefined) {
      if (seenCursors.has(continuation.cursor)) throw new Error("Local history pagination cursor did not make progress");
      seenCursors.add(continuation.cursor);
    }
    const nextParams = continuation ? LocalThreadHistoryParamsSchema.parse({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      ...(params.messageLimit !== undefined ? { messageLimit: params.messageLimit } : {}),
      messagesContinuation: continuation,
    }) : null;
    yield page;
    assertNotAborted(options.signal);
    if (!nextParams) return;
    params = nextParams;
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Local history read was cancelled");
}
