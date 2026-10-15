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
import { ThreadInputReceiptSchema } from "@repo/platform-protocol";
import { ChatImageAttachmentRefSchema } from "@repo/shared-types";
import type { SqlClient, SqlQueryResult, SqlRow } from "../sql.js";
import { PostgresTranscriptRepository } from "../sessions/PostgresTranscriptRepository.js";

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

interface ThreadInputProjectionRow extends SqlRow {
  id?: string;
  session_id?: string;
  user_id?: string;
  thread_id?: string;
  workspace_id?: string;
  client_input_id?: string;
  delivery?: "queue" | "steer";
  target_turn_id?: string | null;
  target_run_attempt_id?: string | null;
  content_json?: unknown;
  state?: string;
  accepted_sequence?: number | string | null;
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
      for (const event of parsed) {
        if (this.options.validateAdmission !== false) {
          await assertAdmittedIdentity(tx, event);
        }
        const appended = await appendOne(tx, event);
        if (this.options.validateAdmission !== false) {
          if (appended.type === "turn.input.accepted") {
            await projectAcceptedThreadInput(tx, appended);
          }
          if (appended.type === "turn.input.applied") {
            await projectAppliedThreadInput(tx, appended);
          }
          if (appended.type === "assistant_message.delta") {
            await projectAssistantMessageDelta(tx, appended);
          }
          if (isTerminalLifecycleEventType(appended.type)) {
            await projectTerminalStatus(tx, appended);
            await projectUndeliveredThreadInputs(tx, appended);
          }
        }
        result.push(appended);
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

async function projectAcceptedThreadInput(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<void> {
  if (event.type !== "turn.input.accepted") return;
  const admissionResult = await client.query<AdmissionRow>(READ_ADMISSION_FOR_EVENT_SQL, [event.turnId]);
  const admission = admissionResult.rows[0];
  if (!admission?.session_id || !admission.run_id) {
    throw new EventStoreError("corrupt_event_stream", "Accepted input has no admitted transcript scope");
  }
  const inputResult = await client.query<ThreadInputProjectionRow>(READ_ACCEPTED_THREAD_INPUT_SQL, [
    event.payload.inputId,
    admission.session_id,
    event.threadId,
    event.turnId,
    event.runAttemptId,
    event.payload.clientInputId,
    event.sequence,
  ]);
  const input = inputResult.rows[0];
  if (!input?.id || !input.user_id || !input.workspace_id || !input.content_json) {
    throw new EventStoreError("corrupt_event_stream", "Accepted input does not match a durable inbox row");
  }
  const storedContent = parseStoredThreadInputContent(input.content_json);
  const images = storedContent.mediaRefs.map((ref) => ChatImageAttachmentRefSchema.parse(ref));
  const transcript = new PostgresTranscriptRepository(client, undefined, true);
  await transcript.appendMessageToExistingSession({
    sessionId: admission.session_id,
    runId: admission.run_id,
    role: "user",
    clientMessageId: event.payload.transcriptMessageId,
    dedupeKey: `thread-input:${input.id}`,
    parts: [{
      type: "text",
      content: {
        text: storedContent.text,
        metadata: {
          canonicalIdentity: {
            threadId: event.threadId,
            turnId: event.turnId,
            runAttemptId: event.runAttemptId,
            inputId: event.payload.inputId,
            acceptedSequence: event.sequence,
          },
          ...(images.length > 0 ? { imageAttachments: images } : {}),
        },
      },
    }],
  });

  const receipt = ThreadInputReceiptSchema.parse({
    status: "accepted",
    clientInputId: event.payload.clientInputId,
    inputId: event.payload.inputId,
    targetTurnId: event.turnId,
    targetRunAttemptId: event.runAttemptId,
    acceptedSequence: event.sequence,
  });
  const updated = await client.query<ThreadInputProjectionRow>(PROJECT_ACCEPTED_THREAD_INPUT_SQL, [
    requiredString(input.session_id, "input.session_id"),
    requiredString(input.id, "input.id"),
    event.sequence,
    JSON.stringify(receipt),
  ]);
  if (!updated.rows[0]) {
    const existing = await client.query<ThreadInputProjectionRow>(READ_ACCEPTED_THREAD_INPUT_SEQUENCE_SQL, [requiredString(input.session_id, "input.session_id"), requiredString(input.id, "input.id")]);
    if (Number(existing.rows[0]?.accepted_sequence) !== event.sequence) {
      throw new EventStoreError("corrupt_event_stream", "Accepted inbox receipt could not be projected");
    }
  } else {
    await client.query(INCREMENT_THREAD_INPUT_REVISION_SQL, [requiredString(input.session_id, "input.session_id"), event.threadId]);
  }
}

async function projectAppliedThreadInput(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<void> {
  if (event.type !== "turn.input.applied") return;
  const admissionResult = await client.query<AdmissionRow>(READ_ADMISSION_FOR_EVENT_SQL, [event.turnId]);
  const admission = admissionResult.rows[0];
  if (!admission?.session_id) {
    throw new EventStoreError("corrupt_event_stream", "Applied input has no admitted inbox scope");
  }
  const receipt = ThreadInputReceiptSchema.parse({
    status: "applied",
    inputId: event.payload.inputId,
    targetTurnId: event.turnId,
    targetRunAttemptId: event.runAttemptId,
    acceptedSequence: event.payload.acceptedSequence,
    appliedSequence: event.sequence,
    modelStep: event.payload.modelStep,
    contextRevision: event.payload.contextRevision,
  });
  const updated = await client.query<ThreadInputProjectionRow>(PROJECT_APPLIED_THREAD_INPUT_SQL, [
    admission.session_id,
    event.payload.inputId,
    event.payload.acceptedSequence,
    event.sequence,
    event.payload.modelStep,
    event.payload.contextRevision,
    JSON.stringify(receipt),
  ]);
  if (!updated.rows[0]) {
    const existing = await client.query<ThreadInputProjectionRow>(READ_APPLIED_THREAD_INPUT_SEQUENCE_SQL, [admission.session_id, event.payload.inputId]);
    if (Number(existing.rows[0]?.accepted_sequence) !== event.payload.acceptedSequence || Number(existing.rows[0]?.applied_sequence) !== event.sequence) {
      throw new EventStoreError("corrupt_event_stream", "Applied inbox receipt has no matching accepted input");
    }
  } else {
    await client.query(INCREMENT_THREAD_INPUT_REVISION_SQL, [admission.session_id, event.threadId]);
  }
}

async function projectUndeliveredThreadInputs(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<void> {
  if (!isTerminalLifecycleEventType(event.type)) return;
  const admissionResult = await client.query<AdmissionRow>(READ_ADMISSION_FOR_EVENT_SQL, [event.turnId]);
  const admission = admissionResult.rows[0];
  if (!admission?.session_id) return;
  const pending = await client.query<ThreadInputProjectionRow>(READ_UNDELIVERED_THREAD_INPUTS_SQL, [
    admission.session_id,
    event.turnId,
    event.runAttemptId,
  ]);
  for (const row of pending.rows) {
    if (!row.id || row.accepted_sequence == null) continue;
    const receipt = ThreadInputReceiptSchema.parse({
      status: "unconfirmed",
      inputId: row.id,
      targetTurnId: event.turnId,
      targetRunAttemptId: event.runAttemptId,
      acceptedSequence: Number(row.accepted_sequence),
      terminalSequence: event.sequence,
    });
    const updated = await client.query<ThreadInputProjectionRow>(MARK_THREAD_INPUT_UNDELIVERED_SQL, [
      admission.session_id,
      row.id,
      JSON.stringify(receipt),
    ]);
    if (updated.rows[0]) {
      await client.query(INCREMENT_THREAD_INPUT_REVISION_SQL, [admission.session_id, event.threadId]);
    }
  }
}

function parseStoredThreadInputContent(value: unknown): { text: string; mediaRefs: unknown[] } {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EventStoreError("corrupt_event_stream", "Stored inbox content is invalid");
  }
  const content = parsed as Record<string, unknown>;
  if (typeof content.text !== "string" || !Array.isArray(content.mediaRefs)) {
    throw new EventStoreError("corrupt_event_stream", "Stored inbox content is invalid");
  }
  return { text: content.text, mediaRefs: content.mediaRefs };
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
  if (event.type === "turn.failed" || event.type === "turn.interrupted") {
    await client.query(PAUSE_THREAD_INPUT_QUEUE_SQL, [admission.session_id, event.threadId, event.type]);
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
const READ_ACCEPTED_THREAD_INPUT_SQL = `SELECT input.id, input.session_id, input.user_id, input.workspace_id, input.content_json FROM thread_inputs input JOIN sessions session ON session.id = input.session_id JOIN canonical_turn_admissions admission ON admission.session_id = input.session_id WHERE input.id = $1 AND input.session_id = $2 AND input.thread_id = $3 AND input.client_input_id = $6 AND session.thread_id = $3 AND session.workspace_id = input.workspace_id AND session.user_id = input.user_id AND admission.turn_id = $4 AND admission.run_attempt_id = $5 AND admission.admission_state = 'admitted' AND (input.delivery = 'queue' OR (input.delivery = 'steer' AND input.target_turn_id = $4 AND input.target_run_attempt_id = $5)) AND input.state IN ('pending','consuming','consumed') AND (input.accepted_sequence IS NULL OR input.accepted_sequence = $7) FOR UPDATE OF input`;
const PROJECT_ACCEPTED_THREAD_INPUT_SQL = `UPDATE thread_inputs SET state = 'consuming', accepted_sequence = $3, receipt_json = $4::jsonb, version = version + 1, updated_at = now() WHERE session_id = $1 AND id = $2 AND accepted_sequence IS NULL RETURNING id`;
const READ_ACCEPTED_THREAD_INPUT_SEQUENCE_SQL = `SELECT accepted_sequence FROM thread_inputs WHERE session_id = $1 AND id = $2`;
const READ_APPLIED_THREAD_INPUT_SEQUENCE_SQL = `SELECT accepted_sequence, applied_sequence FROM thread_inputs WHERE session_id = $1 AND id = $2`;
const INCREMENT_THREAD_INPUT_REVISION_SQL = `UPDATE thread_input_state SET revision = revision + 1, updated_at = now() WHERE session_id = $1 AND thread_id = $2`;
const READ_UNDELIVERED_THREAD_INPUTS_SQL = `SELECT id, accepted_sequence FROM thread_inputs WHERE session_id = $1 AND delivery = 'steer' AND target_turn_id = $2 AND target_run_attempt_id = $3 AND state = 'consuming' AND accepted_sequence IS NOT NULL AND applied_sequence IS NULL FOR UPDATE`;
const MARK_THREAD_INPUT_UNDELIVERED_SQL = `UPDATE thread_inputs SET receipt_json = $3::jsonb, version = version + 1, updated_at = now() WHERE session_id = $1 AND id = $2 AND state = 'consuming' AND accepted_sequence IS NOT NULL AND applied_sequence IS NULL RETURNING id`;
const PROJECT_APPLIED_THREAD_INPUT_SQL = `UPDATE thread_inputs SET state = 'consumed', applied_sequence = $4, model_step = $5, context_revision = $6, receipt_json = $7::jsonb, version = version + 1, consumed_at = now(), updated_at = now() WHERE session_id = $1 AND id = $2 AND accepted_sequence = $3 AND applied_sequence IS NULL AND state = 'consuming' RETURNING id`;
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
const PAUSE_THREAD_INPUT_QUEUE_SQL = `UPDATE thread_input_state SET paused = TRUE, pause_reason = $3, revision = revision + 1, updated_at = now() WHERE session_id = $1 AND thread_id = $2`;
