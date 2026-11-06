import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { EVENT_SCHEMA_VERSION, EventCursorSchema, type EventCursor, PlatformEventSchema, ThreadIdSchema, TurnIdSchema, type PlatformEvent } from "@repo/platform-protocol";
import { TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol/conversation";
import { LifecycleEventSchema, type LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import { EventStoreError, LocalPersistenceError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";
import type { AppendEventInput } from "./types.js";

type AdmissionRow = {
  thread_id: string; request_id: string; workspace_id: string; run_id: string;
  turn_id: string; run_attempt_id: string; item_id: string; fingerprint: string;
  run_event_id: string; turn_event_id: string; prompt_event_id: string;
};

/** Identity and references only: all product records remain in canonical events. */
export class LocalTurnAdmissions {
  constructor(
    private readonly database: Database.Database,
    private readonly append: (input: AppendEventInput) => PlatformEvent,
  ) {}

  initialize(): void {
    const marker = this.database.prepare("SELECT value FROM metadata WHERE key = 'turn_admission_index_v1'").get() as { value: string } | undefined;
    const table = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_admissions'").get();
    if (marker && (marker.value !== "1" || !table)) throw corrupt("Admission index is missing or unsupported");
    if (!table) {
      const history = this.database.prepare("SELECT event_json FROM events WHERE family = 'platform' AND stream_type = 'run' AND sequence = 1").all() as { event_json: string }[];
      if (history.some(({ event_json }) => {
        const event = PlatformEventSchema.parse(JSON.parse(event_json));
        return event.type === "run.created" && event.producer.kind === "runtime_kernel" && event.producer.id === "local-admission";
      })) throw corrupt("Canonical admission history has no matching index");
    }
    if (!marker) {
      if (table) throw corrupt("Admission index has no migration marker");
      this.database.transaction(() => {
        this.database.exec(`CREATE TABLE turn_admissions (
          thread_id TEXT NOT NULL, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE, turn_id TEXT NOT NULL UNIQUE, run_attempt_id TEXT NOT NULL UNIQUE, item_id TEXT NOT NULL UNIQUE,
          fingerprint TEXT NOT NULL, run_event_id TEXT NOT NULL UNIQUE,
          turn_event_id TEXT NOT NULL UNIQUE, prompt_event_id TEXT NOT NULL UNIQUE,
          PRIMARY KEY(thread_id, request_id)
        )`);
        this.database.prepare("INSERT INTO metadata(key,value) VALUES ('turn_admission_index_v1','1')").run();
      }).immediate();
    }
    this.validateSchema();
    const rows = this.database.prepare("SELECT * FROM turn_admissions").all() as AdmissionRow[];
    for (const row of rows) this.reconstruct(row);
    const unindexed = this.database.prepare(`SELECT e.event_json FROM events e LEFT JOIN turn_admissions a ON a.run_event_id = e.event_id
      WHERE e.family = 'platform' AND e.stream_type = 'run' AND e.sequence = 1 AND a.run_event_id IS NULL`).all() as { event_json: string }[];
    for (const { event_json } of unindexed) {
      const event = PlatformEventSchema.parse(JSON.parse(event_json));
      if (event.type === "run.created" && event.producer.kind === "runtime_kernel" && event.producer.id === "local-admission") {
        throw corrupt("Canonical admission history has no matching index entry");
      }
    }
  }

  admit(input: TurnAdmission): { admission: TurnAdmission; newlyAdmitted: boolean } {
    const candidate = TurnAdmissionSchema.parse(input);
    const fingerprint = requestFingerprint(candidate);
    return this.database.transaction(() => {
      const existing = this.findRow(candidate.run.threadId, candidate.clientRequestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new EventStoreError("idempotency_conflict", "Admission request key has different content or configuration");
        return { admission: this.reconstruct(existing), newlyAdmitted: false };
      }
      const prior = this.database.prepare("SELECT * FROM turn_admissions WHERE thread_id = ?").all(candidate.run.threadId) as AdmissionRow[];
      for (const row of prior) {
        const last = this.database.prepare("SELECT event_json FROM events WHERE family = 'lifecycle' AND turn_id = ? ORDER BY sequence DESC LIMIT 1").get(row.turn_id) as { event_json: string } | undefined;
        const event = last ? LifecycleEventSchema.parse(JSON.parse(last.event_json)) : null;
        if (event) this.assertLifecycleIdentity(event);
        if (!event || !["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
          throw new EventStoreError("idempotency_conflict", "Thread has an unsettled admitted Turn");
        }
      }
      const duplicate = this.database.prepare(`SELECT 1 FROM turn_admissions WHERE run_id = ? OR turn_id = ? OR run_attempt_id = ? OR item_id = ?
        UNION ALL SELECT 1 FROM events WHERE (family = 'platform' AND (
          (stream_type = 'run' AND stream_id = ?) OR json_extract(event_json, '$.payload.turn.id') = ?
          OR json_extract(event_json, '$.payload.item.id') = ?)) OR (family = 'lifecycle' AND turn_id = ?) LIMIT 1`)
        .get(candidate.run.id, candidate.turn.id, candidate.runAttemptId, candidate.userMessage.id,
          candidate.run.id, candidate.turn.id, candidate.userMessage.id, candidate.turn.id);
      if (duplicate) throw new EventStoreError("event_id_conflict", "Admission identity already has canonical history");
      const base = {
        threadId: candidate.run.threadId, workspaceId: candidate.run.workspaceId, runId: candidate.run.id,
        scopeType: "run" as const, scopeId: candidate.run.id,
        producer: { kind: "runtime_kernel" as const, id: "local-admission" }, schemaVersion: EVENT_SCHEMA_VERSION as 1,
      };
      // These are envelopes for runtime-supplied canonical records, never lifecycle decisions.
      const run = this.append({ ...base, type: "run.created", payload: { run: candidate.run }, idempotencyKey: `admission:${candidate.run.id}:run` });
      const turn = this.append({ ...base, type: "turn.started", payload: { turn: candidate.turn }, idempotencyKey: `admission:${candidate.run.id}:turn` });
      const prompt = this.append({ ...base, type: "item.completed", payload: { item: candidate.userMessage }, idempotencyKey: `admission:${candidate.run.id}:prompt` });
      this.database.prepare(`INSERT INTO turn_admissions(thread_id,request_id,workspace_id,run_id,turn_id,run_attempt_id,item_id,fingerprint,run_event_id,turn_event_id,prompt_event_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(candidate.run.threadId, candidate.clientRequestId, candidate.run.workspaceId,
          candidate.run.id, candidate.turn.id, candidate.runAttemptId, candidate.userMessage.id, fingerprint, run.eventId, turn.eventId, prompt.eventId);
      const saved = this.findRow(candidate.run.threadId, candidate.clientRequestId);
      if (!saved) throw corrupt("Admission receipt was not stored");
      return { admission: this.reconstruct(saved), newlyAdmitted: true };
    }).immediate();
  }

  findByRequest(threadId: string, clientRequestId: string): TurnAdmission | null {
    ThreadIdSchema.parse(threadId);
    const requestId = TurnAdmissionSchema.innerType().shape.clientRequestId.parse(clientRequestId);
    const row = this.findRow(threadId, requestId);
    return row ? this.reconstruct(row) : null;
  }

  getByTurn(turnId: string): TurnAdmission | null {
    TurnIdSchema.parse(turnId);
    const row = this.database.prepare("SELECT * FROM turn_admissions WHERE turn_id = ?").get(turnId) as AdmissionRow | undefined;
    return row ? this.reconstruct(row) : null;
  }

  listByThread(input: { threadId: string; afterCursor: EventCursor | null; limit: number }): {
    admissions: readonly TurnAdmission[]; nextCursor: EventCursor | null;
  } {
    ThreadIdSchema.parse(input.threadId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new EventStoreError("invalid_replay_limit", "Admission history limit must be between 1 and 1000");
    }
    let afterOrder = 0;
    if (input.afterCursor !== null) {
      const cursor = EventCursorSchema.parse(input.afterCursor);
      const anchor = this.database.prepare(`SELECT e.insertion_order FROM turn_admissions a JOIN events e ON e.event_id = a.run_event_id
        WHERE a.thread_id = ? AND e.cursor = ?`).get(input.threadId, cursor) as { insertion_order: number } | undefined;
      if (!anchor) throw new EventStoreError("cursor_not_found", "Admission cursor does not belong to the requested Thread");
      afterOrder = anchor.insertion_order;
    }
    const rows = this.database.prepare(`SELECT a.*, e.cursor AS history_cursor FROM turn_admissions a JOIN events e ON e.event_id = a.run_event_id
      WHERE a.thread_id = ? AND e.insertion_order > ? ORDER BY e.insertion_order LIMIT ?`)
      .all(input.threadId, afterOrder, input.limit) as (AdmissionRow & { history_cursor: string })[];
    return { admissions: rows.map((row) => this.reconstruct(row)),
      nextCursor: rows.length ? EventCursorSchema.parse(rows.at(-1)?.history_cursor) : null };
  }

  assertLifecycleIdentity(event: LifecycleEvent): void {
    const row = this.database.prepare("SELECT thread_id, run_attempt_id FROM turn_admissions WHERE turn_id = ?").get(event.turnId) as Pick<AdmissionRow, "thread_id" | "run_attempt_id"> | undefined;
    if (row && (row.thread_id !== event.threadId || row.run_attempt_id !== event.runAttemptId)) {
      throw new EventStoreError("corrupt_event_stream", "Lifecycle envelope does not match the admitted Thread and Run Attempt");
    }
  }

  private validateSchema(): void {
    const columns = this.database.pragma("table_info(turn_admissions)") as { name: string; type: string; pk: number; notnull: number }[];
    const expected = ["thread_id", "request_id", "workspace_id", "run_id", "turn_id", "run_attempt_id", "item_id", "fingerprint", "run_event_id", "turn_event_id", "prompt_event_id"];
    if (columns.length !== expected.length || expected.some((name) => !columns.some((column) => column.name === name && column.type.toUpperCase() === "TEXT" && column.notnull === 1))
      || columns.find(({ name }) => name === "thread_id")?.pk !== 1 || columns.find(({ name }) => name === "request_id")?.pk !== 2
      || columns.filter(({ pk }) => pk > 0).length !== 2) throw corrupt("Admission index columns or primary key are incompatible");
    const indexes = this.database.pragma("index_list(turn_admissions)") as { name: string; unique: number; partial: number }[];
    const keys = indexes.filter((index) => index.unique === 1 && index.partial === 0).map((index) => {
      const escaped = index.name.replaceAll("'", "''");
      return (this.database.pragma(`index_info('${escaped}')`) as { name: string }[]).map(({ name }) => name).join(",");
    });
    if (["thread_id,request_id", "run_id", "turn_id", "run_attempt_id", "item_id", "run_event_id", "turn_event_id", "prompt_event_id"].some((key) => !keys.includes(key))) {
      throw corrupt("Admission index uniqueness constraints are incomplete");
    }
  }

  private findRow(threadId: string, requestId: string): AdmissionRow | undefined {
    return this.database.prepare("SELECT * FROM turn_admissions WHERE thread_id = ? AND request_id = ?").get(threadId, requestId) as AdmissionRow | undefined;
  }

  private reconstruct(row: AdmissionRow): TurnAdmission {
    try {
      const events = [row.run_event_id, row.turn_event_id, row.prompt_event_id].map((id) => {
        const stored = this.database.prepare("SELECT event_json FROM events WHERE family = 'platform' AND event_id = ?").get(id) as { event_json: string } | undefined;
        if (!stored) throw corrupt("Admission event reference is missing");
        return PlatformEventSchema.parse(JSON.parse(stored.event_json));
      });
      const [run, turn, prompt] = events;
      if (run?.type !== "run.created" || turn?.type !== "turn.started" || prompt?.type !== "item.completed") throw corrupt("Admission references have invalid event types");
      if (events.some((event, index) => event.sequence !== index + 1 || event.threadId !== row.thread_id || event.workspaceId !== row.workspace_id
        || event.runId !== row.run_id || event.scopeType !== "run" || event.scopeId !== row.run_id || event.producer.kind !== "runtime_kernel")) throw corrupt("Admission references have inconsistent identities");
      const admission = TurnAdmissionSchema.parse({ clientRequestId: row.request_id, run: run.payload.run, turn: turn.payload.turn,
        runAttemptId: row.run_attempt_id, userMessage: prompt.payload.item });
      const lifecycleRows = this.database.prepare("SELECT event_json FROM events WHERE family = 'lifecycle' AND turn_id = ?").all(row.turn_id) as { event_json: string }[];
      for (const saved of lifecycleRows) this.assertLifecycleIdentity(LifecycleEventSchema.parse(JSON.parse(saved.event_json)));
      if (admission.run.id !== row.run_id || admission.turn.id !== row.turn_id || admission.userMessage.id !== row.item_id || requestFingerprint(admission) !== row.fingerprint) throw corrupt("Admission fingerprint is inconsistent");
      return admission;
    } catch { throw corrupt("Admission index does not match canonical history"); }
  }
}

function requestFingerprint({ run, turn, userMessage }: TurnAdmission): string {
  return createHash("sha256").update(createStableEventFingerprint({
    workspaceId: run.workspaceId, threadId: run.threadId, userId: run.userId,
    mode: run.mode, providerId: run.providerId, modelId: run.modelId,
    permissionProfileId: run.permissionProfileId, executionCapability: run.executionCapability ?? "repository",
    parentTurnId: turn.parentTurnId, parentItemId: userMessage.parentItemId, branchId: userMessage.branchId,
    content: userMessage.content,
  })).digest("hex");
}
function corrupt(message: string): LocalPersistenceError { return new LocalPersistenceError("corrupt", message); }
