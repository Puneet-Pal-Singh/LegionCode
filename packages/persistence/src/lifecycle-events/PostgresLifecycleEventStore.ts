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
import type { SqlClient, SqlRow } from "../sql.js";

interface LifecycleEventRow extends SqlRow {
  event_json?: unknown;
  sequence?: number | string;
}

export class PostgresLifecycleEventStore implements LifecycleEventStore {
  constructor(private readonly client: SqlClient) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const parsed = events.map((event) => LifecycleEventSchema.parse(event));
    return await this.client.transaction(async (tx) => {
      const result: LifecycleEvent[] = [];
      for (const event of parsed) result.push(await appendOne(tx, event));
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

async function appendOne(
  client: SqlClient,
  event: LifecycleEvent,
): Promise<LifecycleEvent> {
  const existing = await client.query<LifecycleEventRow>(READ_IDEMPOTENT_SQL, [
    event.turnId,
    event.idempotencyKey,
  ]);
  if (existing.rows[0]) return resolveRetry(readEvent(existing.rows[0]), event);
  const previous = await client.query<LifecycleEventRow>(
    READ_LAST_SEQUENCE_SQL,
    [event.turnId],
  );
  const last = Number(previous.rows[0]?.sequence ?? 0);
  if (event.sequence !== last + 1) {
    throw new EventStoreError("sequence_gap", `Expected sequence ${last + 1}`);
  }
  const inserted = await client.query<LifecycleEventRow>(INSERT_SQL, [
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
  const row = inserted.rows[0];
  if (!row)
    throw new EventStoreError(
      "corrupt_event_stream",
      "Lifecycle insert returned no event",
    );
  return readEvent(row);
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
}

const READ_IDEMPOTENT_SQL = `SELECT event_json, sequence FROM canonical_lifecycle_events WHERE turn_id = $1 AND idempotency_key = $2`;
const READ_LAST_SEQUENCE_SQL = `SELECT sequence FROM canonical_lifecycle_events WHERE turn_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
const INSERT_SQL = `INSERT INTO canonical_lifecycle_events (event_id, thread_id, turn_id, run_attempt_id, sequence, idempotency_key, event_type, event_json, schema_version, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING event_json, sequence`;
const REPLAY_SQL = `SELECT event_json, sequence FROM canonical_lifecycle_events WHERE turn_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`;
