import {
  EventStoreError,
  createStableEventFingerprint,
  type LifecycleEventStore,
  type ReplayLifecycleEventsInput,
  type ReplayLifecycleEventsResult,
} from "@repo/event-store";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import type { SqlClient, SqlQueryResult, SqlRow } from "../sql.js";
import { projectLifecycleEvents } from "../lifecycle-projections/LifecycleProjector.js";

interface LifecycleEventRow extends SqlRow {
  event_json?: unknown;
  sequence?: number | string;
}

interface AdmissionRow extends SqlRow {
  session_id?: string;
  thread_id?: string;
  run_attempt_id?: string;
  run_id?: string;
  revision_of_turn_id?: string | null;
  admission_state?: "reserved" | "admitted";
}

interface SessionRow extends SqlRow {
  session_id?: string;
  last_sequence?: number | string;
  active_run_id?: string | null;
  latest_turn_id?: string | null;
}

interface TranscriptProjectionRow extends SqlRow {
  message_id?: string;
}

export class PostgresLifecycleEventStore implements LifecycleEventStore {
  constructor(
    private readonly client: SqlClient,
    private readonly options: { validateAdmission?: boolean } = {},
  ) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const parsed = events.map((event) => LifecycleEventSchema.parse(event));
    return await this.client.transaction(async (tx) => {
      const result: LifecycleEvent[] = [];
      const turns = new Set<string>();
      for (const event of parsed) {
        if (this.options.validateAdmission !== false) {
          await assertAdmittedIdentity(tx, event);
        }
        const appended = await appendOne(tx, event);
        if (this.options.validateAdmission !== false) {
          if (appended.type === "assistant_message.delta") {
            await projectAssistantMessageDelta(tx, appended);
          }
          if (isTerminalLifecycleEventType(appended.type)) {
            await projectTerminalStatus(tx, appended);
          }
          turns.add(appended.turnId);
        }
        result.push(appended);
      }
      for (const turnId of turns) {
        const events = await tx.query<LifecycleEventRow>(READ_TURN_EVENTS_SQL, [turnId]);
        const snapshot = projectLifecycleEvents(events.rows.map(readEvent));
        if (snapshot) {
          await tx.query(UPSERT_LIFECYCLE_PROJECTION_SQL, [
            snapshot.turnId,
            snapshot.lastSequence,
            1,
            JSON.stringify(snapshot),
          ]);
        }
      }
      return result;
    });
  }

  async replay(
    input: ReplayLifecycleEventsInput,
  ): Promise<ReplayLifecycleEventsResult> {
    validateReplay(input);
    const result = await this.client.query<LifecycleEventRow>(REPLAY_SQL, [
      input.turnId,
      input.afterSequence ?? 0,
      input.limit,
    ]);
    const events = result.rows.map(readEvent);
    assertContinuous(events, input.afterSequence ?? 0);
    return { events, nextSequence: events.at(-1)?.sequence ?? null };
  }
}

async function assertAdmittedIdentity(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<AdmissionRow> {
  const result = await client.query<AdmissionRow>(READ_ADMISSION_FOR_EVENT_SQL, [event.turnId]);
  const row = result.rows[0];
  if (
    !row ||
    row.admission_state !== "admitted" ||
    row.thread_id !== event.threadId ||
    row.run_attempt_id !== event.runAttemptId
  ) {
    throw new EventStoreError(
      "corrupt_event_stream",
      "Lifecycle event identity does not match an admitted turn",
    );
  }
  return row;
}

async function projectAssistantMessageDelta(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<void> {
  if (event.type !== "assistant_message.delta") return;
  const admissionResult = await client.query<AdmissionRow>(READ_ADMISSION_FOR_EVENT_SQL, [event.turnId]);
  const admission = admissionResult.rows[0];
  const delta = event.payload.delta;
  const canonicalPhase = event.payload.phase;
  if (canonicalPhase !== "commentary" && canonicalPhase !== "final_answer") return;
  if (!admission || !delta) return;
  const sessionId = requiredString(admission.session_id, "session_id");
  const runId = requiredString(admission.run_id, "run_id");
  const sessionResult = await client.query<SessionRow>(READ_SESSION_BY_THREAD_SQL, [sessionId, event.threadId]);
  const session = sessionResult.rows[0];
  if (!session || session.session_id !== sessionId) {
    throw new EventStoreError("corrupt_event_stream", "Admitted lifecycle thread has no matching transcript session");
  }

  const key = `${event.turnId}:${event.runAttemptId}:${event.itemId}:${canonicalPhase}`;
  const insertedMessage = await client.query<TranscriptProjectionRow>(INSERT_ASSISTANT_ITEM_SQL, [
    sessionId,
    runId,
    event.turnId,
    event.runAttemptId,
    event.itemId,
    canonicalPhase,
    key,
  ]);
  const messageId = insertedMessage.rows[0]?.message_id;
  const existingMessage = messageId
    ? null
    : await client.query<TranscriptProjectionRow>(READ_ASSISTANT_ITEM_SQL, [
        sessionId,
        event.turnId,
        event.runAttemptId,
        event.itemId,
        canonicalPhase,
      ]);
  const resolvedMessageId = messageId ?? existingMessage?.rows[0]?.message_id;
  if (!resolvedMessageId) throw new EventStoreError("corrupt_event_stream", "Assistant transcript item projection is missing");

  const priorPart = await client.query<TranscriptProjectionRow>(READ_PROJECTED_EVENT_PART_SQL, [event.eventId]);
  if (priorPart.rows[0]) return;
  const sequenceResult = await client.query<SessionRow>(ALLOCATE_SESSION_SEQUENCE_SQL, [session.session_id]);
  const sequence = sequenceResult.rows[0]?.last_sequence;
  if (sequence === undefined) throw new EventStoreError("corrupt_event_stream", "Transcript session sequence allocation failed");
  const content = {
    text: delta,
    metadata: {
      canonicalIdentity: {
        threadId: event.threadId,
        turnId: event.turnId,
        runAttemptId: event.runAttemptId,
        ...(admission.revision_of_turn_id ? { revisionOfTurnId: admission.revision_of_turn_id } : {}),
      },
      phase: canonicalPhase,
      itemId: event.itemId,
    },
  };
  await client.query(INSERT_ASSISTANT_DELTA_PART_SQL, [
    sessionId,
    resolvedMessageId,
    runId,
    Number(sequence),
    JSON.stringify(content),
    event.eventId,
    event.createdAt,
  ]);
}

async function projectTerminalStatus(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<void> {
  const result = await client.query<AdmissionRow>(READ_ADMISSION_FOR_EVENT_SQL, [event.turnId]);
  const admission = result.rows[0];
  if (!admission?.session_id || !admission.run_id) return;
  const activeResult = await client.query<SessionRow>(READ_ACTIVE_TURN_SQL, [admission.session_id]);
  const active = activeResult.rows[0];
  await client.query(SETTLE_ADMISSION_EXECUTION_SQL, [event.turnId]);
  const state = event.type === "turn.completed" ? "completed" : event.type === "turn.interrupted" ? "paused" : "failed";
  const runState = event.type === "turn.completed" ? "completed" : event.type === "turn.interrupted" ? "cancelled" : "failed";
  await client.query(SETTLE_RUN_STATUS_SQL, [admission.run_id, admission.session_id, runState, event.createdAt, event.turnId]);
  if (active?.active_run_id === admission.run_id && active.latest_turn_id === event.turnId) {
    await client.query(SETTLE_ACTIVE_SESSION_SQL, [admission.session_id, admission.run_id, state, event.createdAt, event.turnId]);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new EventStoreError("corrupt_event_stream", `Lifecycle admission is missing ${field}`);
  }
  return value;
}

async function appendOne(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<LifecycleEvent> {
  await lockTurnStream(client, event.turnId);
  const existing = await client.query<LifecycleEventRow>(READ_IDEMPOTENT_SQL, [
    event.turnId,
    event.idempotencyKey,
  ]);
  if (existing.rows[0]) return resolveRetry(readEvent(existing.rows[0]), event);
  const previous = await client.query<LifecycleEventRow>(
    READ_LAST_SEQUENCE_SQL,
    [event.turnId],
  );
  const previousEvent = await client.query<LifecycleEventRow>(
    READ_LAST_EVENT_SQL,
    [event.turnId],
  );
  if (previousEvent.rows[0]?.event_json) {
    const previousType = readEvent(previousEvent.rows[0]).type;
    if (isTerminalLifecycleEventType(previousType)) {
      throw new EventStoreError(
        "terminal_stream",
        `Turn ${event.turnId} already has terminal lifecycle evidence`,
      );
    }
  }
  const last = Number(previous.rows[0]?.sequence ?? 0);
  if (event.sequence !== last + 1) {
    throw new EventStoreError("sequence_gap", `Expected sequence ${last + 1}`);
  }
  const inserted = await insertEvent(client, event);
  const row = inserted.rows[0];
  if (!row)
    throw new EventStoreError(
      "corrupt_event_stream",
      "Lifecycle insert returned no event",
    );
  return readEvent(row);
}

async function lockTurnStream(
  client: SqlClient,
  turnId: string,
): Promise<void> {
  await client.query(LOCK_TURN_STREAM_SQL, [turnId]);
}

async function insertEvent(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<SqlQueryResult<LifecycleEventRow>> {
  try {
    return await client.query<LifecycleEventRow>(INSERT_SQL, [
      event.eventId,
      event.threadId,
      event.turnId,
      event.runAttemptId,
      event.sequence,
      event.idempotencyKey,
      event.type,
      JSON.stringify(event),
      event.schemaVersion,
      event.createdAt,
    ]);
  } catch (error) {
    throw mapInsertError(error);
  }
}

function mapInsertError(error: unknown): Error {
  const constraint = readConstraint(error);
  if (constraint === "canonical_lifecycle_events_pkey") {
    return new EventStoreError(
      "event_id_conflict",
      "Lifecycle event ID already exists",
    );
  }
  if (constraint === "canonical_lifecycle_events_turn_sequence_idx") {
    return new EventStoreError(
      "sequence_gap",
      "Lifecycle sequence already exists",
    );
  }
  if (constraint === "canonical_lifecycle_events_turn_idempotency_idx") {
    return new EventStoreError(
      "idempotency_conflict",
      "Lifecycle idempotency key already exists",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return error.code === "23505" &&
    "constraint" in error &&
    typeof error.constraint === "string"
    ? error.constraint
    : null;
}

function resolveRetry(
  existing: LifecycleEvent,
  incoming: LifecycleEvent,
): LifecycleEvent {
  if (
    createStableEventFingerprint(existing) !==
    createStableEventFingerprint(incoming)
  ) {
    throw new EventStoreError(
      "idempotency_conflict",
      "Lifecycle idempotency conflict",
    );
  }
  return existing;
}

function readEvent(row: LifecycleEventRow): LifecycleEvent {
  const value =
    typeof row.event_json === "string"
      ? JSON.parse(row.event_json)
      : row.event_json;
  return LifecycleEventSchema.parse(value);
}

function assertContinuous(
  events: readonly LifecycleEvent[],
  after: number,
): void {
  events.forEach((event, index) => {
    if (event.sequence !== after + index + 1) {
      throw new EventStoreError(
        "corrupt_event_stream",
        "Lifecycle replay contains a sequence gap",
      );
    }
  });
}

function validateReplay(input: ReplayLifecycleEventsInput): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1_000
  ) {
    throw new EventStoreError(
      "invalid_replay_limit",
      "Invalid lifecycle replay limit",
    );
  }
  if (
    input.afterSequence !== null &&
    (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)
  ) {
    throw new EventStoreError(
      "cursor_not_found",
      "Invalid lifecycle replay sequence",
    );
  }
}

const LOCK_TURN_STREAM_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;
const READ_IDEMPOTENT_SQL = `SELECT event_json, sequence FROM canonical_lifecycle_events WHERE turn_id = $1 AND idempotency_key = $2`;
const READ_LAST_SEQUENCE_SQL = `SELECT sequence FROM canonical_lifecycle_events WHERE turn_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
const READ_LAST_EVENT_SQL = `SELECT event_json, sequence FROM canonical_lifecycle_events WHERE turn_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
const INSERT_SQL = `INSERT INTO canonical_lifecycle_events (event_id, thread_id, turn_id, run_attempt_id, sequence, idempotency_key, event_type, event_json, schema_version, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING event_json, sequence`;

function isTerminalLifecycleEventType(type: LifecycleEvent["type"]): boolean {
  return type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted";
}
const REPLAY_SQL = `SELECT event_json, sequence FROM canonical_lifecycle_events WHERE turn_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`;

const READ_ADMISSION_FOR_EVENT_SQL = `SELECT session_id, thread_id, turn_id, run_attempt_id, run_id, revision_of_turn_id, admission_state FROM canonical_turn_admissions WHERE turn_id = $1`;
const READ_SESSION_BY_THREAD_SQL = `SELECT id AS session_id, last_sequence FROM sessions WHERE id = $1 AND thread_id = $2`;
const INSERT_ASSISTANT_ITEM_SQL = `INSERT INTO messages (session_id, run_id, canonical_turn_id, canonical_run_attempt_id, canonical_item_id, canonical_phase, role, dedupe_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,'assistant',$7,now()) ON CONFLICT (session_id, canonical_turn_id, canonical_run_attempt_id, canonical_item_id, canonical_phase) WHERE canonical_turn_id IS NOT NULL AND canonical_run_attempt_id IS NOT NULL AND canonical_item_id IS NOT NULL AND canonical_phase IS NOT NULL DO NOTHING RETURNING id AS message_id`;
const READ_ASSISTANT_ITEM_SQL = `SELECT id AS message_id FROM messages WHERE session_id = $1 AND canonical_turn_id = $2 AND canonical_run_attempt_id = $3 AND canonical_item_id = $4 AND canonical_phase = $5`;
const READ_PROJECTED_EVENT_PART_SQL = `SELECT id FROM message_parts WHERE source_event_id = $1`;
const ALLOCATE_SESSION_SEQUENCE_SQL = `UPDATE sessions SET last_sequence = last_sequence + 1, updated_at = now() WHERE id = $1 RETURNING last_sequence`;
const INSERT_ASSISTANT_DELTA_PART_SQL = `INSERT INTO message_parts (session_id, message_id, run_id, part_type, session_sequence, content_json, source_event_id, created_at) VALUES ($1,$2,$3,'text',$4,$5::jsonb,$6,$7)`;
const READ_ACTIVE_TURN_SQL = `SELECT s.active_run_id, s.current_turn_id AS latest_turn_id FROM sessions s WHERE s.id = $1 FOR UPDATE`;
const SETTLE_RUN_STATUS_SQL = `UPDATE runs SET status = $3, completed_at = $4, updated_at = now() WHERE id = $1 AND session_id = $2 AND NOT EXISTS (SELECT 1 FROM canonical_turn_admissions later JOIN canonical_turn_admissions settled ON settled.turn_id = $5 WHERE later.session_id = settled.session_id AND later.run_id = $1 AND later.admission_order > settled.admission_order)`;
const SETTLE_ACTIVE_SESSION_SQL = `UPDATE sessions SET status = $3, active_run_id = NULL, updated_at = $4 WHERE id = $1 AND active_run_id = $2 AND current_turn_id = $5`;
const SETTLE_ADMISSION_EXECUTION_SQL = `UPDATE canonical_turn_admissions SET execution_state = 'settled' WHERE turn_id = $1 AND admission_state = 'admitted'`;
const READ_TURN_EVENTS_SQL = `SELECT event_json, sequence FROM canonical_lifecycle_events WHERE turn_id = $1 ORDER BY sequence ASC`;
const UPSERT_LIFECYCLE_PROJECTION_SQL = `INSERT INTO canonical_lifecycle_projections (turn_id, last_sequence, projection_version, projection_json) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (turn_id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence, projection_version = EXCLUDED.projection_version, projection_json = EXCLUDED.projection_json, updated_at = now() WHERE canonical_lifecycle_projections.last_sequence <= EXCLUDED.last_sequence`;
