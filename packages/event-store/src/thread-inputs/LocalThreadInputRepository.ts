import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES, appServerJsonByteLength,
  ChatImageAttachmentRefSchema, ItemIdSchema, LifecycleEventSchema,
  PlatformEventSchema, ThreadInputQueueItemSchema, ThreadInputQueueSnapshotSchema,
  ThreadInputReceiptSchema, TurnAdmissionSchema, TurnIdSchema,
  type LifecycleEvent, type PlatformEvent, type TurnAdmission, type TurnId,
} from "@repo/platform-protocol";
import { LocalPersistenceError } from "../errors.js";
import { readLocalOwnedThread } from "../local-thread-ownership.js";
import { parseStoredGrant } from "../local-workspace-grant.js";
import type { LocalTurnAdmissions } from "../local-turn-admissions.js";
import type { AppendEventInput } from "../types.js";
import { ThreadInputConflictError } from "./errors.js";
import { createStableEventFingerprint } from "../fingerprint.js";
import type { ClaimQueuedInputForSteering, CreateThreadInput, StoredThreadInput, ThreadInputMutation, ThreadInputRepository, ThreadInputScope, UpdateThreadInput } from "./types.js";

const RecordSchema = ThreadInputQueueItemSchema.extend({
  sessionId: z.string().min(1), userId: z.string().min(1), threadId: z.string().min(1), workspaceId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mediaFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(), mediaRevision: z.number().int().positive().safe().nullable(),
}).strict().superRefine((item, context) => {
  if (item.sessionId !== item.threadId || (item.delivery === "steer" && (!item.targetTurnId || !item.targetRunAttemptId)) ||
      (item.mediaRefs.length > 0) !== (item.mediaFingerprint !== null && item.mediaRevision !== null) ||
      (item.delivery === "queue" && (item.targetTurnId !== null || item.targetRunAttemptId !== null)) ||
      (item.receipt?.status === "started" && (item.delivery !== "queue" || item.state !== "consumed")) ||
      (item.receipt?.status === "cancelled" && item.state !== "cancelled") ||
      (item.receipt?.status === "conflict" && item.state !== "cancelled"))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Local input scope or immutable media ownership is inconsistent" });
});
type Row = { item_id: string; thread_id: string; user_id: string; workspace_id: string; client_input_id: string;
  order_number: number; version: number; state: StoredThreadInput["state"]; delivery: StoredThreadInput["delivery"]; record_json: string };
type State = { thread_id: string; user_id: string; workspace_id: string; revision: number; next_order: number; paused: number; pause_reason: string | null };
export type LocalQueuedInputStart = ThreadInputScope & {
  readonly itemId: string; readonly expectedVersion: number; readonly expectedRevision: number;
  readonly explicitStart: boolean; readonly candidate: TurnAdmission;
  readonly expectedPredecessorTurnId: TurnId | null;
};

/** One adapter on LocalPersistence's existing connection. All command, receipt,
 * lifecycle and admission writes use this same transaction owner. */
export class LocalThreadInputRepository implements ThreadInputRepository {
  constructor(private readonly database: Database.Database, private readonly admissions: LocalTurnAdmissions,
    private readonly appendPlatform: (input: AppendEventInput) => PlatformEvent) {}

  initialize(): void {
    const marker = this.database.prepare("SELECT value FROM metadata WHERE key='local_thread_inputs_v1'").get() as { value: string } | undefined;
    const tables = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_thread_inputs','local_thread_input_state')").all();
    if (marker ? marker.value !== "1" || tables.length !== 2 : tables.length !== 0) throw corrupt("Local input schema is incomplete");
    if (!marker) {
      const history = this.database.prepare("SELECT event_json FROM events WHERE family='lifecycle' AND json_extract(event_json,'$.type') IN ('turn.input.accepted','turn.input.applied')")
        .iterate() as Iterable<{ event_json: string }>;
      for (const row of history) {
        const event = LifecycleEventSchema.parse(JSON.parse(row.event_json));
        const admission = this.admissions.getByTurn(event.turnId);
        if (!admission) throw corrupt("Input history has no canonical admission");
        if (!isDelegated(admission)) throw corrupt("Canonical Native input history has no durable inbox");
      }
      this.database.transaction(() => {
        this.database.exec(`CREATE TABLE local_thread_input_state (
          thread_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),next_order INTEGER NOT NULL DEFAULT 0 CHECK(next_order>=0),
          paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),pause_reason TEXT);
          CREATE TABLE local_thread_inputs (
          item_id TEXT PRIMARY KEY NOT NULL,thread_id TEXT NOT NULL REFERENCES local_thread_input_state(thread_id),
          user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,client_input_id TEXT NOT NULL,order_number INTEGER NOT NULL CHECK(order_number>0),
          version INTEGER NOT NULL CHECK(version>0),state TEXT NOT NULL CHECK(state IN ('pending','consuming','consumed','cancelled')),
          delivery TEXT NOT NULL CHECK(delivery IN ('queue','steer')),record_json TEXT NOT NULL,
          UNIQUE(thread_id,workspace_id,client_input_id),UNIQUE(thread_id,order_number));
          CREATE INDEX local_thread_inputs_pending ON local_thread_inputs(thread_id,state,order_number);`);
        this.database.prepare("INSERT INTO metadata(key,value) VALUES ('local_thread_inputs_v1','1')").run();
      }).immediate();
    }
    for (const [table, required, unique] of [
      ["local_thread_input_state", ["thread_id", "user_id", "workspace_id", "revision", "next_order", "paused", "pause_reason"], [["thread_id"]]],
      ["local_thread_inputs", ["item_id", "thread_id", "user_id", "workspace_id", "client_input_id", "order_number", "version", "state", "delivery", "record_json"],
        [["item_id"], ["thread_id", "workspace_id", "client_input_id"], ["thread_id", "order_number"]]],
    ] as const) {
      const columns = this.database.pragma(`table_info(${table})`) as { name: string; pk: number }[];
      if (required.some((name) => !columns.some((column) => column.name === name))) throw corrupt("Local input columns are incomplete");
      const indexes = this.database.pragma(`index_list(${table})`) as { name: string; unique: number; partial: number }[];
      const keys = indexes.filter((index) => index.unique === 1 && index.partial === 0).map((index) =>
        (this.database.pragma(`index_info('${index.name.replaceAll("'", "''")}')`) as { name: string }[]).map((column) => column.name).join(","));
      if (unique.some((key) => !keys.includes(key.join(",")))) throw corrupt("Local input uniqueness is incomplete");
    }
    for (const state of this.database.prepare("SELECT * FROM local_thread_input_state").iterate() as Iterable<State>) {
      this.validateState(state, { sessionId: state.thread_id, threadId: state.thread_id, userId: state.user_id, workspaceId: state.workspace_id });
      readLocalOwnedThread(this.database, { threadId: state.thread_id, userId: state.user_id, workspaceId: state.workspace_id }, false);
    }
    for (const row of this.database.prepare("SELECT * FROM local_thread_inputs").iterate() as Iterable<Row>) {
      const item = this.parseRow(row);
      const state = this.state(item);
      if (!state || item.order > state.next_order) throw corrupt("Input order has no canonical queue state");
      this.validateReceipt(item);
    }
    for (const row of this.database.prepare("SELECT event_json FROM events WHERE family='lifecycle' AND json_extract(event_json,'$.type') IN ('turn.input.accepted','turn.input.applied')").iterate() as Iterable<{ event_json: string }>) {
      const event = LifecycleEventSchema.parse(JSON.parse(row.event_json));
      if (event.type !== "turn.input.accepted" && event.type !== "turn.input.applied") throw corrupt("Input history query returned a foreign event");
      const admission = this.admissions.getByTurn(event.turnId);
      if (!admission) throw corrupt("Input history has no canonical admission");
      if (isDelegated(admission)) continue;
      const item = this.get(scopeOf(admission), event.payload.inputId);
      if (!item || (item.receipt?.status !== "accepted" && item.receipt?.status !== "applied" && item.receipt?.status !== "unconfirmed") ||
          item.receipt.acceptedSequence !== (event.type === "turn.input.accepted" ? event.sequence : event.payload.acceptedSequence))
        throw corrupt("Canonical input history has no matching durable receipt");
    }
  }

  async enqueue(input: CreateThreadInput) {
    return this.database.transaction(() => {
      this.authorize(input, true);
      const state = this.ensureState(input);
      const prior = this.database.prepare("SELECT * FROM local_thread_inputs WHERE thread_id=? AND workspace_id=? AND client_input_id=?")
        .get(input.threadId, input.workspaceId, input.clientInputId) as Row | undefined;
      if (prior) {
        const item = this.parseRow(prior);
        if (item.fingerprint !== input.fingerprint) throw new ThreadInputConflictError("Client input ID was reused with different content", "client_input_conflict");
        return { item, revision: state.revision, duplicate: true };
      }
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM local_thread_inputs WHERE thread_id=? AND state IN ('pending','consuming')").get(input.threadId) as { count: number };
      if (count.count >= 500) throw new ThreadInputConflictError("Queue exceeds its supported item bound", "queue_capacity_exceeded");
      if (input.delivery === "steer") this.requireTarget(input, input.targetTurnId, input.targetRunAttemptId);
      const item = RecordSchema.parse({ ...input, itemId: input.itemId ?? randomUUID(), order: state.next_order + 1, version: 1,
        state: "pending", targetTurnId: input.targetTurnId ?? null, targetRunAttemptId: input.targetRunAttemptId ?? null,
        receipt: null, mediaFingerprint: input.mediaFingerprint ?? null, mediaRevision: input.mediaRevision ?? null });
      this.database.prepare(`INSERT INTO local_thread_inputs(item_id,thread_id,user_id,workspace_id,client_input_id,order_number,version,state,delivery,record_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(item.itemId, item.threadId, item.userId, item.workspaceId, item.clientInputId, item.order, item.version, item.state, item.delivery, JSON.stringify(item));
      this.database.prepare("UPDATE local_thread_input_state SET next_order=? WHERE thread_id=?").run(item.order, item.threadId);
      const revision = this.bump(input);
      this.assertBudget(input);
      return { item, revision, duplicate: false };
    }).immediate();
  }

  async list(input: ThreadInputScope) {
    return this.database.transaction(() => { this.authorize(input, false); return this.snapshot(input); })();
  }
  async getById(input: ThreadInputScope & { itemId: string }) {
    return this.database.transaction(() => { this.authorize(input, false); return this.get(input, input.itemId); })();
  }
  /** Private immutable media/history read; current folder selection is not historical ownership. */
  async readForMedia(input: ThreadInputScope & { itemId: string }) {
    return this.database.transaction(() => { readLocalOwnedThread(this.database, input, false); return this.get(input, input.itemId); })();
  }
  async listAcceptedForTurn(input: ThreadInputScope & { turnId: string; runAttemptId: string }) {
    return this.database.transaction(() => {
      const admission = this.requireTarget(input, input.turnId, input.runAttemptId);
      const rows = this.database.prepare("SELECT * FROM local_thread_inputs WHERE thread_id=? AND delivery='steer' ORDER BY order_number").iterate(input.threadId) as Iterable<Row>;
      const inputs: StoredThreadInput[] = [];
      for (const row of rows) {
        const item = this.parseRow(row);
        if (item.targetTurnId !== admission.turn.id || item.targetRunAttemptId !== admission.runAttemptId) continue;
        if (item.receipt?.status === "accepted" || item.receipt?.status === "applied" || item.receipt?.status === "unconfirmed") {
          this.validateReceipt(item); inputs.push(item);
        }
      }
      return inputs;
    })();
  }

  async update(input: UpdateThreadInput): Promise<ThreadInputMutation> {
    return this.change(input, (current) => current.state !== "pending" || current.version !== input.expectedVersion ? null : ({ ...current,
      text: input.text, mediaRefs: input.mediaRefs ?? current.mediaRefs, configuration: input.configuration ?? current.configuration,
      mediaFingerprint: input.mediaFingerprint === undefined ? current.mediaFingerprint ?? null : input.mediaFingerprint,
      mediaRevision: input.mediaRevision === undefined ? current.mediaRevision ?? null : input.mediaRevision,
      version: current.version + 1 }));
  }
  async claimForSteering(input: ClaimQueuedInputForSteering): Promise<ThreadInputMutation> {
    return this.change(input, (current) => {
      this.requireTarget(input, input.targetTurnId, input.targetRunAttemptId);
      return current.state !== "pending" || current.delivery !== "queue" || current.version !== input.expectedVersion ? null : ({ ...current,
        delivery: "steer", state: "consuming", targetTurnId: input.targetTurnId, targetRunAttemptId: input.targetRunAttemptId, version: current.version + 1 });
    });
  }
  async remove(input: ThreadInputScope & { itemId: string; expectedVersion: number }): Promise<ThreadInputMutation> {
    return this.database.transaction(() => {
      this.authorize(input, true); const current = this.get(input, input.itemId);
      if (!current || current.version !== input.expectedVersion || current.state !== "pending") return mutationConflict(current);
      const revision = this.bump(input);
      const item = this.put({ ...current, state: "cancelled", version: current.version + 1,
        receipt: ThreadInputReceiptSchema.parse({ status: "cancelled", itemId: current.itemId, version: current.version + 1, revision }) }, current.version);
      return { status: "changed" as const, item, revision };
    }).immediate();
  }
  async setPaused(input: ThreadInputScope & { paused: boolean; reason: string | null }) {
    return this.database.transaction(() => { this.authorize(input, false); this.ensureState(input);
      this.database.prepare("UPDATE local_thread_input_state SET paused=?,pause_reason=? WHERE thread_id=?").run(input.paused ? 1 : 0, input.paused ? input.reason : null, input.threadId);
      return this.bump(input);
    }).immediate();
  }
  async recordReceipt(input: ThreadInputScope & { itemId: string; expectedVersion: number; receipt: StoredThreadInput["receipt"]; state: StoredThreadInput["state"] }): Promise<ThreadInputMutation> {
    if (!input.receipt || input.receipt.status !== "conflict") throw corrupt("Only canonical lifecycle/admission may write input delivery receipts");
    return this.change(input, (current) => current.version !== input.expectedVersion || current.receipt !== null ? null : ({ ...current,
      state: input.state, receipt: input.receipt, version: current.version + 1 }));
  }

  reserveQueuedStart(input: LocalQueuedInputStart) {
    return this.database.transaction(() => {
      this.authorize(input, true);
      const item = this.get(input, input.itemId); const state = this.state(input);
      if (!item || !state) throw new ThreadInputConflictError("Queue item is missing", "queue_item_changed");
      if (item.receipt?.status === "started") {
        const admission = this.admissions.getByTurn(item.receipt.turnId);
        if (!admission || admission.run.id !== item.receipt.runId || admission.runAttemptId !== item.receipt.runAttemptId ||
            admission.clientRequestId !== `thread-input:${item.itemId}`) throw corrupt("Started queue receipt conflicts with canonical admission");
        return { admission, newlyAdmitted: false };
      }
      if (state.revision !== input.expectedRevision) throw new ThreadInputConflictError("Queue revision changed", "queue_revision_conflict");
      if (item.state !== "pending" || item.delivery !== "queue" || item.version !== input.expectedVersion) throw new ThreadInputConflictError("Queue item changed", "queue_item_changed");
      const expectedPredecessorTurnId = TurnIdSchema.nullable().parse(input.expectedPredecessorTurnId);
      const latestCanonical = this.admissions.listByThread({ threadId: input.threadId, latest: true, limit: 1, afterCursor: null });
      if ((latestCanonical.admissions.at(-1)?.turn.id ?? null) !== expectedPredecessorTurnId)
        throw new ThreadInputConflictError("Thread predecessor changed before queued admission", "queue_revision_conflict");
      const latest = this.latest(input);
      if (latest && !latest.terminal) throw new ThreadInputConflictError("Thread is not idle", "thread_not_idle");
      if (!input.explicitStart && (state.paused || latest?.terminal?.type !== "turn.completed")) throw new ThreadInputConflictError("Queue is paused or has no completed predecessor", "queue_paused");
      const candidate = TurnAdmissionSchema.parse(input.candidate);
      if (candidate.userMessage.type !== "user_message" || isDelegated(candidate))
        throw new ThreadInputConflictError("Native queue cannot admit a delegated or non-user candidate", "thread_scope_conflict");
      const images = ChatImageAttachmentRefSchema.array().parse(candidate.userMessage.content.images ?? []);
      if (candidate.clientRequestId !== `thread-input:${item.itemId}` || candidate.run.userId !== input.userId ||
          candidate.run.workspaceId !== input.workspaceId || candidate.run.threadId !== input.threadId ||
          candidate.userMessage.type !== "user_message" || candidate.userMessage.content.text !== item.text || images.length !== item.mediaRefs.length ||
          (images.length > 0 && candidate.userMessage.content.imageFingerprint !== item.mediaFingerprint) ||
          images.some((image, index) => image.name !== item.mediaRefs[index]?.name || image.mediaType !== item.mediaRefs[index]?.mediaType || image.byteSize !== item.mediaRefs[index]?.byteSize))
        throw corrupt("Queued candidate differs from its canonical intent or image batch");
      const result = this.admissions.admitWithin(candidate);
      if (!result.newlyAdmitted) throw corrupt("Queued admission exists without its atomic queue receipt");
      this.put({ ...item, state: "consumed", version: item.version + 1, receipt: ThreadInputReceiptSchema.parse({ status: "started", itemId: item.itemId,
        turnId: result.admission.turn.id, runAttemptId: result.admission.runAttemptId, runId: result.admission.run.id }) }, item.version);
      if (input.explicitStart) this.database.prepare("UPDATE local_thread_input_state SET paused=0,pause_reason=NULL WHERE thread_id=?").run(input.threadId);
      this.bump(input);
      return result;
    }).immediate();
  }

  onAdmissionWithin(admission: TurnAdmission): void {
    if (this.state(scopeOf(admission))) this.bump(scopeOf(admission));
  }
  projectLifecycleWithin(event: LifecycleEvent): void {
    const admission = this.admissions.getByTurn(event.turnId);
    if (!admission || isDelegated(admission)) return;
    const scope = scopeOf(admission);
    if (event.threadId !== admission.run.threadId || event.runAttemptId !== admission.runAttemptId || event.producer.id !== admission.run.workerId)
      throw corrupt("Input projection lifecycle has a foreign scope or producer");
    if (event.type === "turn.started") { if (this.state(scope)) this.bump(scope); return; }
    if (event.type === "turn.input.accepted" || event.type === "turn.input.applied") {
      const item = this.get(scope, event.payload.inputId);
      if (!item || item.delivery !== "steer" || item.targetTurnId !== event.turnId || item.targetRunAttemptId !== event.runAttemptId)
        throw corrupt("Canonical input event has no exact durable target");
      if (event.type === "turn.input.accepted") {
        if (item.clientInputId !== event.payload.clientInputId || event.payload.transcriptMessageId !== `thread-input:${item.itemId}` ||
            item.receipt !== null || !["pending", "consuming"].includes(item.state)) throw corrupt("Input acceptance conflicts with its durable inbox");
        this.appendAcceptedUser(admission, item, event);
        this.put({ ...item, state: "consuming", version: item.version + 1, receipt: ThreadInputReceiptSchema.parse({ status: "accepted",
          clientInputId: item.clientInputId, inputId: item.itemId, targetTurnId: event.turnId, targetRunAttemptId: event.runAttemptId, acceptedSequence: event.sequence }) }, item.version);
      } else {
        if (item.receipt?.status !== "accepted" || item.receipt.acceptedSequence !== event.payload.acceptedSequence || item.state !== "consuming")
          throw corrupt("Applied input has no matching canonical acceptance");
        this.put({ ...item, state: "consumed", version: item.version + 1, receipt: ThreadInputReceiptSchema.parse({ status: "applied", inputId: item.itemId,
          targetTurnId: event.turnId, targetRunAttemptId: event.runAttemptId, acceptedSequence: event.payload.acceptedSequence,
          appliedSequence: event.sequence, modelStep: event.payload.modelStep, contextRevision: event.payload.contextRevision }) }, item.version);
      }
      this.bump(scope); return;
    }
    if (isTerminal(event)) {
      this.ensureState(scope);
      let unknownInput = false;
      for (const row of this.database.prepare("SELECT * FROM local_thread_inputs WHERE thread_id=? AND state IN ('pending','consuming') AND delivery='steer'").iterate(scope.threadId) as Iterable<Row>) {
        const item = this.parseRow(row);
        if (item.targetTurnId !== event.turnId || item.targetRunAttemptId !== event.runAttemptId) continue;
        if (item.receipt === null) { unknownInput = true; continue; }
        if (item.receipt.status !== "accepted") continue;
        unknownInput = true;
        this.put({ ...item, version: item.version + 1, receipt: ThreadInputReceiptSchema.parse({ status: "unconfirmed", inputId: item.itemId,
          targetTurnId: event.turnId, targetRunAttemptId: event.runAttemptId, acceptedSequence: item.receipt.acceptedSequence, terminalSequence: event.sequence }) }, item.version);
      }
      if (event.type !== "turn.completed" || unknownInput)
        this.database.prepare("UPDATE local_thread_input_state SET paused=1,pause_reason=? WHERE thread_id=?")
          .run(unknownInput ? "Steering delivery requires reconciliation." : event.type, scope.threadId);
      this.bump(scope);
    }
  }

  private change(input: ThreadInputScope & { itemId: string }, apply: (item: StoredThreadInput) => StoredThreadInput | null): ThreadInputMutation {
    return this.database.transaction(() => {
      this.authorize(input, true); const current = this.get(input, input.itemId);
      if (!current) return mutationConflict(current);
      const next = apply(current); if (!next) return mutationConflict(current);
      const item = this.put(next, current.version); const revision = this.bump(input); this.assertBudget(input);
      return { status: "changed" as const, item, revision };
    }).immediate();
  }
  private put(input: StoredThreadInput, previousVersion: number): StoredThreadInput {
    const item = RecordSchema.parse(input);
    if (item.version !== previousVersion + 1) throw corrupt("Input version is not a single CAS increment");
    const result = this.database.prepare("UPDATE local_thread_inputs SET version=?,state=?,delivery=?,record_json=? WHERE item_id=? AND version=?")
      .run(item.version, item.state, item.delivery, JSON.stringify(item), item.itemId, previousVersion);
    if (result.changes !== 1) throw corrupt("Local input lost its original CAS owner");
    return item;
  }
  private get(scope: ThreadInputScope, itemId: string): StoredThreadInput | null {
    const row = this.database.prepare("SELECT * FROM local_thread_inputs WHERE item_id=?").get(itemId) as Row | undefined;
    if (!row) return null; const item = this.parseRow(row);
    if (item.userId !== scope.userId || item.threadId !== scope.threadId || item.workspaceId !== scope.workspaceId || item.sessionId !== scope.sessionId)
      throw new ThreadInputConflictError("Input scope changed", "thread_scope_conflict");
    return item;
  }
  private parseRow(row: Row): StoredThreadInput {
    const item = RecordSchema.parse(JSON.parse(row.record_json));
    if (row.item_id !== item.itemId || row.thread_id !== item.threadId || row.user_id !== item.userId || row.workspace_id !== item.workspaceId ||
        row.client_input_id !== item.clientInputId || row.order_number !== item.order || row.version !== item.version || row.state !== item.state || row.delivery !== item.delivery)
      throw corrupt("Local input index conflicts with canonical queue content");
    return item;
  }
  private state(scope: ThreadInputScope): State | null {
    const row = this.database.prepare("SELECT * FROM local_thread_input_state WHERE thread_id=?").get(scope.threadId) as State | undefined;
    if (row) this.validateState(row, scope); return row ?? null;
  }
  private validateState(row: State, scope: ThreadInputScope): void {
    if (row.thread_id !== scope.threadId || row.user_id !== scope.userId || row.workspace_id !== scope.workspaceId ||
        !Number.isSafeInteger(row.revision) || row.revision < 0 || !Number.isSafeInteger(row.next_order) || row.next_order < 0 ||
        ![0, 1].includes(row.paused) || (row.paused === 0 && row.pause_reason !== null) || (row.pause_reason !== null && (typeof row.pause_reason !== "string" || row.pause_reason.length > 2000))) throw corrupt("Local queue state is invalid");
  }
  private ensureState(scope: ThreadInputScope): State {
    this.database.prepare("INSERT OR IGNORE INTO local_thread_input_state(thread_id,user_id,workspace_id) VALUES (?,?,?)").run(scope.threadId, scope.userId, scope.workspaceId);
    return this.state(scope)!;
  }
  private bump(scope: ThreadInputScope): number {
    const state = this.ensureState(scope); if (!Number.isSafeInteger(state.revision + 1)) throw corrupt("Queue revision is exhausted");
    this.database.prepare("UPDATE local_thread_input_state SET revision=revision+1 WHERE thread_id=?").run(scope.threadId); return state.revision + 1;
  }
  private authorize(scope: ThreadInputScope, active: boolean): void {
    if (scope.sessionId !== scope.threadId) throw new ThreadInputConflictError("Local input session must be its canonical Thread", "thread_scope_conflict");
    readLocalOwnedThread(this.database, scope, active);
    const row = this.database.prepare("SELECT value_json FROM workspace_grant WHERE id=1").get() as { value_json: string } | undefined;
    if (!row || parseStoredGrant(JSON.parse(row.value_json)).grant.workspaceId !== scope.workspaceId)
      throw new ThreadInputConflictError("Workspace is no longer granted", "thread_scope_conflict");
  }
  private requireTarget(scope: ThreadInputScope, turnId: string | undefined, attemptId: string | undefined): TurnAdmission {
    const admission = turnId ? this.admissions.getByTurn(turnId) : null;
    if (!admission || admission.runAttemptId !== attemptId || admission.run.userId !== scope.userId || admission.run.workspaceId !== scope.workspaceId || admission.run.threadId !== scope.threadId)
      throw new ThreadInputConflictError("Input target differs from canonical admission", "target_superseded");
    return admission;
  }
  private latest(scope: ThreadInputScope) {
    const row = this.database.prepare(`SELECT a.turn_id FROM turn_admissions a JOIN events e ON e.event_id=a.run_event_id
      WHERE a.thread_id=? ORDER BY e.insertion_order DESC LIMIT 1`).get(scope.threadId) as { turn_id: string } | undefined;
    if (!row) return null;
    const admission = this.admissions.getByTurn(row.turn_id); if (!admission) throw corrupt("Queue active admission disappeared");
    this.requireTarget(scope, admission.turn.id, admission.runAttemptId);
    const eventRow = this.database.prepare("SELECT event_json FROM events WHERE family='lifecycle' AND turn_id=? ORDER BY sequence DESC LIMIT 1").get(row.turn_id) as { event_json: string } | undefined;
    const last = eventRow ? LifecycleEventSchema.parse(JSON.parse(eventRow.event_json)) : null;
    if (last && (last.threadId !== scope.threadId || last.turnId !== admission.turn.id || last.runAttemptId !== admission.runAttemptId || (!isDelegated(admission) && last.producer.id !== admission.run.workerId))) throw corrupt("Queue active lifecycle scope changed");
    return { admission, terminal: last && isTerminal(last) ? last : null };
  }
  private snapshot(scope: ThreadInputScope) {
    const state = this.state(scope); const latest = this.latest(scope);
    const rows = this.database.prepare("SELECT * FROM local_thread_inputs WHERE thread_id=? AND state IN ('pending','consuming') ORDER BY order_number LIMIT 501").all(scope.threadId) as Row[];
    if (rows.length > 500) throw corrupt("Local queue exceeds its public item bound");
    const started = this.database.prepare("SELECT * FROM local_thread_inputs WHERE thread_id=? AND json_extract(record_json,'$.receipt.status')='started' ORDER BY order_number DESC LIMIT 1").get(scope.threadId) as Row | undefined;
    const lastStarted = started ? this.parseRow(started) : null;
    return ThreadInputQueueSnapshotSchema.parse({ threadId: scope.threadId, workspaceId: scope.workspaceId, revision: state?.revision ?? 0,
      paused: state?.paused === 1, pauseReason: state?.pause_reason ?? null, activeRunId: latest && !latest.terminal ? latest.admission.run.id : null,
      latestStarted: lastStarted?.receipt?.status === "started" ? { order: lastStarted.order, receipt: lastStarted.receipt } : null,
      items: rows.map((row) => {
        const { itemId, clientInputId, order, version, state: itemState, delivery, targetTurnId, targetRunAttemptId,
          text, mediaRefs, configuration, receipt } = this.parseRow(row);
        return { itemId, clientInputId, order, version, state: itemState, delivery, targetTurnId, targetRunAttemptId, text, mediaRefs, configuration, receipt };
      }) });
  }
  private assertBudget(scope: ThreadInputScope): void {
    const snapshot = this.snapshot(scope);
    // Reserve receipt/target growth before accepting intent; lifecycle ACKs may
    // add accepted/unconfirmed metadata but must never lose a transportable row.
    const future = snapshot.items.reduce((bytes, item) => bytes + (item.receipt ? 0 : 4096 + appServerJsonByteLength(item.clientInputId)), 0);
    if (appServerJsonByteLength(snapshot) + future > APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES - 4096)
      throw new ThreadInputConflictError("Queue exceeds its supported response byte budget", "queue_capacity_exceeded");
  }
  private appendAcceptedUser(admission: TurnAdmission, item: StoredThreadInput, event: Extract<LifecycleEvent, { type: "turn.input.accepted" }>): void {
    const priorRow = this.database.prepare("SELECT event_json FROM events WHERE family='platform' AND stream_type='run' AND stream_id=? AND json_extract(event_json,'$.type')='item.completed' ORDER BY sequence DESC LIMIT 1").get(admission.run.id) as { event_json: string } | undefined;
    const prior = priorRow ? PlatformEventSchema.parse(JSON.parse(priorRow.event_json)) : null;
    if (!prior || prior.type !== "item.completed") throw corrupt("Accepted input has no canonical user parent");
    const row = this.database.prepare("SELECT MAX(sequence) AS sequence FROM events WHERE family='platform' AND stream_type='run' AND stream_id=?").get(admission.run.id) as { sequence: number };
    this.appendPlatform({ type: "item.completed", threadId: item.threadId, workspaceId: item.workspaceId, runId: admission.run.id,
      scopeType: "run", scopeId: admission.run.id, producer: event.producer, schemaVersion: 1, idempotencyKey: `thread-input:${item.itemId}`,
      payload: { item: { id: ItemIdSchema.parse(`itm_input_${item.itemId.replaceAll("-", "")}`), threadId: admission.run.threadId,
        runId: admission.run.id, turnId: admission.turn.id, parentItemId: prior.payload.item.id, branchId: admission.userMessage.branchId,
        role: "user", type: "user_message", status: "completed", createdAt: event.createdAt, completedAt: event.createdAt, eventSequence: row.sequence + 1,
        content: { text: item.text, inputId: item.itemId, acceptedSequence: event.sequence, images: item.mediaRefs,
          imageFingerprint: item.mediaFingerprint ?? null, mediaRevision: item.mediaRevision ?? null } } } });
  }
  private validateReceipt(item: StoredThreadInput): void {
    const receipt = item.receipt; if (!receipt) return;
    if (receipt.status === "started") {
      const admission = this.requireTarget(item, receipt.turnId, receipt.runAttemptId);
      if (admission.run.id !== receipt.runId || admission.clientRequestId !== `thread-input:${item.itemId}`) throw corrupt("Queued start receipt lost canonical admission");
    } else if (receipt.status === "accepted" || receipt.status === "applied" || receipt.status === "unconfirmed") {
      const admission = this.requireTarget(item, receipt.targetTurnId, receipt.targetRunAttemptId);
      const row = this.database.prepare("SELECT event_json FROM events WHERE family='lifecycle' AND turn_id=? AND sequence=?").get(admission.turn.id, receipt.acceptedSequence) as { event_json: string } | undefined;
      const accepted = row ? LifecycleEventSchema.parse(JSON.parse(row.event_json)) : null;
      if (!accepted || accepted.type !== "turn.input.accepted" || accepted.payload.inputId !== item.itemId || accepted.payload.clientInputId !== item.clientInputId ||
          accepted.payload.transcriptMessageId !== `thread-input:${item.itemId}` ||
          item.targetTurnId !== admission.turn.id || item.targetRunAttemptId !== admission.runAttemptId ||
          accepted.turnId !== admission.turn.id || accepted.sequence !== receipt.acceptedSequence ||
          accepted.producer.id !== admission.run.workerId || accepted.threadId !== item.threadId || accepted.runAttemptId !== admission.runAttemptId) throw corrupt("Input receipt has no matching canonical acceptance");
      const projected = this.database.prepare("SELECT event_json FROM events WHERE family='platform' AND stream_type='run' AND stream_id=? AND idempotency_key=?")
        .get(admission.run.id, `thread-input:${item.itemId}`) as { event_json: string } | undefined;
      const userEvent = projected ? PlatformEventSchema.parse(JSON.parse(projected.event_json)) : null;
      const saved = userEvent?.type === "item.completed" ? userEvent.payload.item : null;
      if (!saved || saved.type !== "user_message" || saved.role !== "user" || saved.status !== "completed" ||
          saved.threadId !== item.threadId || saved.turnId !== admission.turn.id || saved.runId !== admission.run.id ||
          saved.id !== `itm_input_${item.itemId.replaceAll("-", "")}` || saved.content.text !== item.text ||
          saved.content.inputId !== item.itemId || saved.content.acceptedSequence !== receipt.acceptedSequence ||
          saved.content.imageFingerprint !== (item.mediaFingerprint ?? null) || saved.content.mediaRevision !== (item.mediaRevision ?? null) ||
          createStableEventFingerprint(saved.content.images) !== createStableEventFingerprint(item.mediaRefs))
        throw corrupt("Accepted input has no exact canonical user message");
      if (receipt.status === "accepted" && item.state !== "consuming") throw corrupt("Accepted input state conflicts with its receipt");
      if (receipt.status === "applied" || receipt.status === "unconfirmed") {
        const sequence = receipt.status === "applied" ? receipt.appliedSequence : receipt.terminalSequence;
        const ending = this.database.prepare("SELECT event_json FROM events WHERE family='lifecycle' AND turn_id=? AND sequence=?")
          .get(admission.turn.id, sequence) as { event_json: string } | undefined;
        const event = ending ? LifecycleEventSchema.parse(JSON.parse(ending.event_json)) : null;
        if (!event || event.threadId !== item.threadId || event.turnId !== admission.turn.id || event.runAttemptId !== admission.runAttemptId ||
            event.producer.id !== admission.run.workerId || sequence <= receipt.acceptedSequence) throw corrupt("Input receipt has no canonical ending");
        if (receipt.status === "applied") {
          if (event.type !== "turn.input.applied" || event.payload.inputId !== item.itemId || event.payload.acceptedSequence !== receipt.acceptedSequence ||
              event.payload.modelStep !== receipt.modelStep || event.payload.contextRevision !== receipt.contextRevision || item.state !== "consumed")
            throw corrupt("Applied input receipt differs from canonical model application");
        } else if (!isTerminal(event) || item.state !== "consuming") throw corrupt("Unconfirmed input has no canonical terminal");
      }
    }
  }
}
function mutationConflict(current: StoredThreadInput | null): ThreadInputMutation {
  return { status: "conflict", code: current && current.state !== "pending" ? "queue_item_consumed" : "queue_item_changed" };
}
function scopeOf(admission: TurnAdmission): ThreadInputScope {
  return { sessionId: admission.run.threadId, threadId: admission.run.threadId, userId: admission.run.userId, workspaceId: admission.run.workspaceId };
}
function isTerminal(event: LifecycleEvent): event is Extract<LifecycleEvent, { type: "turn.completed" | "turn.failed" | "turn.interrupted" }> {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted";
}
function corrupt(message: string): LocalPersistenceError { return new LocalPersistenceError("corrupt", message); }

function isDelegated(admission: TurnAdmission): boolean {
  return ("harnessSelection" in admission.run && admission.run.harnessSelection !== undefined) ||
    (admission.userMessage.type === "user_message" && admission.userMessage.content.harnessSelection !== undefined);
}
