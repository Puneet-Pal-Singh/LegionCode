import type Database from "better-sqlite3";
import {
  ChatImageAttachmentRefSchema, ConversationHistoryMessageSchema, EventCursorSchema, ItemIdSchema, TurnIdSchema,
  PlatformEventSchema, type ConversationHistoryMessage, type EventCursor, type TurnAdmission, type TurnId, type ItemId,
} from "@repo/platform-protocol";
import { EventStoreError, LocalPersistenceError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";
import { platformFingerprint } from "./local-platform-fingerprint.js";
import { readLocalOwnedThread } from "./local-thread-ownership.js";
import { parseStoredGrant } from "./local-workspace-grant.js";
import type { LocalTurnAdmissions } from "./local-turn-admissions.js";
import type { LocalThreadInputRepository } from "./thread-inputs/LocalThreadInputRepository.js";

export type LocalThreadUserHistoryContinuation = {
  readonly turnIds: readonly TurnId[]; readonly cursor: EventCursor | null; readonly throughCursor: EventCursor;
  readonly direction: "forward" | "backward";
};
export type LocalThreadUserHistoryWindow = {
  readonly turnIds: readonly TurnId[]; readonly throughCursor: EventCursor;
  readonly firstCursor: EventCursor | null; readonly lastCursor: EventCursor | null;
  readonly hasEarlier: boolean; readonly hasLater: boolean;
  readonly lastUserByTurn: readonly { readonly turnId: TurnId; readonly itemId: ItemId }[];
};
export type LocalThreadUserHistoryPage = {
  readonly messages: readonly ConversationHistoryMessage[]; readonly messagesWindow: LocalThreadUserHistoryWindow;
  readonly messagesContinuation?: LocalThreadUserHistoryContinuation;
};
export type LocalThreadUserHistoryInput = {
  readonly threadId: string; readonly workspaceId: string; readonly userId: string;
  readonly turnIds: readonly TurnId[]; readonly cursor: EventCursor | null; readonly throughCursor?: EventCursor;
  readonly direction: "forward" | "backward"; readonly limit: number;
  readonly allowEmptyPrefix: boolean; readonly maxBytes: number;
  /** Pure synchronous encoder of the complete caller envelope, including admissions. */
  readonly measure: (page: LocalThreadUserHistoryPage) => number;
};
type Row = { event_json: string; event_id: string; thread_id: string; cursor: string; sequence: number;
  stream_type: string; stream_id: string; fingerprint: string; idempotency_key: string; insertion_order: number };

/** Immutable canonical user-item projection only. No inbox/lifecycle writer or
 * host paths are exposed, and rows are read incrementally on the same store. */
export function readLocalThreadUserHistory(database: Database.Database, admissions: LocalTurnAdmissions,
  inputs: LocalThreadInputRepository, input: LocalThreadUserHistoryInput): LocalThreadUserHistoryPage {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || !["forward", "backward"].includes(input.direction))
    throw new EventStoreError("invalid_replay_limit", "User history page limit or direction is invalid");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new EventStoreError("invalid_replay_byte_budget", "History byte budget is invalid");
  return database.transaction(() => {
    readLocalOwnedThread(database, input, false);
    const grant = database.prepare("SELECT value_json FROM workspace_grant WHERE id=1").get() as { value_json: string } | undefined;
    if (!grant || parseStoredGrant(JSON.parse(grant.value_json)).grant.workspaceId !== input.workspaceId) throw corrupt();
    const parsedTurnIds = TurnIdSchema.array().min(1).max(100)
      .refine((ids) => new Set(ids).size === ids.length).safeParse(input.turnIds);
    if (!parsedTurnIds.success) throw cursorConflict();
    const turnIds = parsedTurnIds.data;
    const owned = new Map<string, TurnAdmission>();
    for (const turnId of turnIds) {
      const admission = admissions.getByTurn(turnId);
      if (!admission || admission.run.userId !== input.userId || admission.run.workspaceId !== input.workspaceId || admission.run.threadId !== input.threadId)
        throw cursorConflict();
      owned.set(admission.run.id, admission);
    }
    const select = `SELECT * FROM events WHERE family='platform' AND thread_id=? AND stream_type='run'
      AND stream_id IN (${Array.from(owned, () => "?").join(",")}) AND json_extract(event_json,'$.type')='item.completed'
      AND json_extract(event_json,'$.payload.item.role')='user'`;
    const args = [input.threadId, ...owned.keys()];
    const parse = (row: Row): ConversationHistoryMessage => {
      const event = PlatformEventSchema.parse(JSON.parse(row.event_json));
      const admission = owned.get(row.stream_id);
      if (!admission || event.type !== "item.completed" || event.threadId !== input.threadId || event.workspaceId !== input.workspaceId ||
          event.runId !== admission.run.id || event.scopeType !== "run" || event.scopeId !== admission.run.id ||
          row.event_id !== event.eventId || row.thread_id !== event.threadId || row.cursor !== event.cursor ||
          row.sequence !== event.sequence || row.stream_type !== event.scopeType || row.stream_id !== event.scopeId ||
          row.idempotency_key !== event.idempotencyKey || row.fingerprint !== platformFingerprint(event) ||
          !Number.isSafeInteger(row.insertion_order) || row.insertion_order < 1 || event.producer.kind !== "runtime_kernel") throw corrupt();
      const item = event.payload.item;
      if (item.type !== "user_message" || item.role !== "user" || item.status !== "completed" ||
          item.threadId !== input.threadId || item.runId !== admission.run.id || item.turnId !== admission.turn.id ||
          item.eventSequence !== event.sequence || typeof item.content.text !== "string") throw corrupt();
      const initial = item.id === admission.userMessage.id;
      const native = !("harnessSelection" in admission.run && admission.run.harnessSelection !== undefined) &&
        admission.userMessage.type === "user_message" && admission.userMessage.content.harnessSelection === undefined;
      if (initial) {
        if (event.producer.id !== "local-admission" || createStableEventFingerprint(item) !== createStableEventFingerprint(admission.userMessage)) throw corrupt();
      } else {
        if (event.producer.id !== admission.run.workerId) throw corrupt();
        if (native) {
          const inputId = typeof item.content.inputId === "string" ? item.content.inputId : "";
          const saved = inputs.readHistoryInputWithin({ sessionId: input.threadId, threadId: input.threadId,
            userId: input.userId, workspaceId: input.workspaceId }, inputId);
          if (!saved || !saved.receipt || !["accepted", "applied", "unconfirmed"].includes(saved.receipt.status) ||
              saved.targetTurnId !== admission.turn.id || saved.targetRunAttemptId !== admission.runAttemptId ||
              event.idempotencyKey !== `thread-input:${saved.itemId}`) throw corrupt();
        }
      }
      const images = ChatImageAttachmentRefSchema.array().max(8).parse(item.content.images ?? []);
      return ConversationHistoryMessageSchema.parse({ id: item.id, role: "user", content: item.content.text, createdAt: item.createdAt,
        data: { metadata: { canonicalIdentity: { threadId: input.threadId, turnId: admission.turn.id,
          runAttemptId: admission.runAttemptId, ...(typeof item.content.inputId === "string" ? { inputId: item.content.inputId } : {}),
          ...(typeof item.content.acceptedSequence === "number" ? { acceptedSequence: item.content.acceptedSequence } : {}) },
          transcriptMessageId: initial ? admission.clientRequestId : event.idempotencyKey,
          eventId: event.eventId, eventCursor: event.cursor, eventSequence: event.sequence,
          ...(images.length ? { imageAttachments: images } : {}),
        } } });
    };
    const through = input.throughCursor === undefined
      ? database.prepare(`${select} ORDER BY insertion_order DESC LIMIT 1`).get(...args) as Row | undefined
      : database.prepare(`${select} AND cursor=?`).get(...args, EventCursorSchema.parse(input.throughCursor)) as Row | undefined;
    if (!through) throw cursorConflict();
    parse(through);
    let anchorOrder = input.direction === "forward" ? 0 : through.insertion_order + 1;
    if (input.cursor !== null) {
      const anchor = database.prepare(`${select} AND cursor=?`).get(...args, EventCursorSchema.parse(input.cursor)) as Row | undefined;
      if (!anchor || anchor.insertion_order > through.insertion_order) throw cursorConflict();
      parse(anchor); anchorOrder = anchor.insertion_order;
    }
    const lastUserByTurn: { turnId: TurnId; itemId: ItemId }[] = [];
    for (const admission of owned.values()) {
      const last = database.prepare(`${select} AND stream_id=? AND insertion_order<=? ORDER BY insertion_order DESC LIMIT 1`)
        .get(...args, admission.run.id, through.insertion_order) as Row | undefined;
      if (!last) throw input.throughCursor === undefined ? corrupt() : cursorConflict();
      const message = parse(last);
      // id was parsed by the canonical ThreadItem schema above.
      lastUserByTurn.push({ turnId: admission.turn.id, itemId: ItemIdSchema.parse(message.id) });
    }
    const selected: { message: ConversationHistoryMessage; cursor: EventCursor; order: number }[] = [];
    const forward = input.direction === "forward";
    const continuation = (cursor: EventCursor | null): LocalThreadUserHistoryContinuation => ({
      turnIds, cursor, direction: input.direction, throughCursor: EventCursorSchema.parse(through.cursor),
    });
    const exists = (comparison: "<" | ">", order: number) => Boolean(database.prepare(
      `${select} AND insertion_order${comparison}? AND insertion_order<=? LIMIT 1`).get(...args, order, through.insertion_order));
    const pageFor = (rows: typeof selected): LocalThreadUserHistoryPage => {
      const ordered = forward ? rows : [...rows].reverse();
      const first = ordered[0]; const last = ordered.at(-1);
      const hasEarlier = exists("<", first?.order ?? anchorOrder);
      const hasLater = exists(">", last?.order ?? anchorOrder);
      const more = forward ? hasLater : hasEarlier;
      return { messages: ordered.map((row) => row.message), messagesWindow: {
        turnIds, throughCursor: EventCursorSchema.parse(through.cursor), firstCursor: first?.cursor ?? null,
        lastCursor: last?.cursor ?? null, hasEarlier, hasLater, lastUserByTurn,
      }, ...(more ? { messagesContinuation: continuation(rows.at(-1)?.cursor ?? input.cursor) } : {}) };
    };
    const measure = (page: LocalThreadUserHistoryPage) => {
      const bytes = input.measure(page);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw corrupt();
      return bytes;
    };
    const empty = pageFor(selected);
    if (measure(empty) > input.maxBytes) throw new LocalThreadUserHistoryFrameTooLargeError(measure(empty) - input.maxBytes);
    const rows = database.prepare(`${select} AND insertion_order${forward ? ">" : "<"}? AND insertion_order<=?
      ORDER BY insertion_order ${forward ? "ASC" : "DESC"} LIMIT ?`)
      .iterate(...args, anchorOrder, through.insertion_order, input.limit) as Iterable<Row>;
    for (const row of rows) {
      const candidate = { message: parse(row), cursor: EventCursorSchema.parse(row.cursor), order: row.insertion_order };
      const proposed = pageFor([...selected, candidate]);
      if (measure(proposed) > input.maxBytes) {
        if (!selected.length && !input.allowEmptyPrefix)
          throw new EventStoreError("history_row_too_large", "The next saved user message exceeds the response byte budget");
        return pageFor(selected);
      }
      selected.push(candidate);
    }
    return pageFor(selected);
  })();
}
export class LocalThreadUserHistoryFrameTooLargeError extends EventStoreError {
  constructor(readonly excessBytes: number) { super("history_row_too_large", "History admission frame requires a smaller page"); }
}
function corrupt() { return new LocalPersistenceError("corrupt", "Saved user history conflicts with canonical ownership or event content"); }
function cursorConflict() { return new EventStoreError("cursor_conflict", "Saved user history cursor does not belong to its exact Thread and Turn snapshot"); }
