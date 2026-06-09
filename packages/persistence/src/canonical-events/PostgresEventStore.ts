import {
  EventCursorSchema,
  EventScopeSchema,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
  type EventScope,
  type PlatformEvent,
} from "@repo/platform-protocol";
import {
  EventStoreError,
  createStableEventFingerprint,
  type AppendEventInput,
  type EventStore,
  type EventStoreClock,
  type EventStoreIdGenerator,
  type ReplayEventsInput,
  type ReplayEventsResult,
} from "@repo/event-store";
import type { SqlClient, SqlRow } from "../sql.js";
import {
  ADVANCE_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL,
  ENSURE_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL,
  LOCK_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL,
} from "./sequence.js";

const MAX_REPLAY_LIMIT = 1_000;
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

const systemClock: EventStoreClock = {
  now: () => new Date().toISOString(),
};

const systemIdGenerator: EventStoreIdGenerator = {
  nextEventId: () => `evt_${crypto.randomUUID()}` as EventId,
  nextCursor: () => `cursor_${crypto.randomUUID()}` as EventCursor,
};

interface CanonicalEventRow extends SqlRow {
  event_id?: string;
  scope_type?: string;
  scope_id?: string;
  thread_id?: string;
  run_id?: string | null;
  workspace_id?: string;
  sequence?: number | string;
  cursor?: string;
  idempotency_key?: string;
  event_type?: string;
  payload_json?: unknown;
  schema_version?: number | string;
  producer_kind?: string;
  producer_id?: string | null;
  created_at?: string | Date;
}

interface SequenceRow extends SqlRow {
  next_sequence?: number | string;
}

export class PostgresEventStore implements EventStore {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: EventStoreClock = systemClock,
    private readonly idGenerator: EventStoreIdGenerator = systemIdGenerator,
  ) {}

  async append(input: AppendEventInput): Promise<PlatformEvent> {
    return await this.client.transaction(async (tx) => {
      return await this.appendInTransaction(tx, input);
    });
  }

  async appendBatch(
    inputs: readonly AppendEventInput[],
  ): Promise<readonly PlatformEvent[]> {
    return await this.client.transaction(async (tx) => {
      const events: PlatformEvent[] = [];
      for (const input of inputs) {
        events.push(await this.appendInTransaction(tx, input));
      }
      return events;
    });
  }

  async replay(input: ReplayEventsInput): Promise<ReplayEventsResult> {
    const scope = EventScopeSchema.parse(input.scope);
    const afterCursor = parseReplayCursor(input.afterCursor);
    validateReplayLimit(input.limit);
    const afterSequence = await this.readAfterSequence(scope, afterCursor);
    const result = await this.client.query<CanonicalEventRow>(REPLAY_EVENTS_SQL, [
      scope.scopeType,
      scope.scopeId,
      afterSequence,
      input.limit,
    ]);
    const events = result.rows.map(mapCanonicalEventRow);
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? null,
    };
  }

  private async appendInTransaction(
    client: SqlClient,
    input: AppendEventInput,
  ): Promise<PlatformEvent> {
    const scope = EventScopeSchema.parse({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    });
    await ensureScopeSequence(client, scope);
    const sequence = await lockScopeSequence(client, scope);
    const existing = await findExistingIdempotentEvent(client, input);
    if (existing) {
      return resolveIdempotentRetry(existing, input);
    }

    const event = createEvent(input, sequence, this.clock, this.idGenerator);
    const inserted = await insertEvent(client, event);
    await advanceScopeSequence(client, scope, sequence);
    return inserted;
  }

  private async readAfterSequence(
    scope: EventScope,
    afterCursor: EventCursor | null,
  ): Promise<number> {
    if (afterCursor === null) {
      return 0;
    }
    const result = await this.client.query<CanonicalEventRow>(
      READ_CURSOR_SEQUENCE_SQL,
      [scope.scopeType, scope.scopeId, afterCursor],
    );
    const row = result.rows[0];
    if (!row) {
      throw new EventStoreError(
        "cursor_not_found",
        "Replay cursor does not exist in the requested scope",
      );
    }
    return toNumber(row.sequence, "sequence");
  }
}

async function ensureScopeSequence(
  client: SqlClient,
  scope: EventScope,
): Promise<void> {
  await client.query(ENSURE_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL, [
    scope.scopeType,
    scope.scopeId,
  ]);
}

async function lockScopeSequence(
  client: SqlClient,
  scope: EventScope,
): Promise<number> {
  const result = await client.query<SequenceRow>(
    LOCK_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL,
    [scope.scopeType, scope.scopeId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EventStoreError(
      "cursor_conflict",
      "Canonical event scope sequence row was not available after ensure",
    );
  }
  return toNumber(row.next_sequence, "next_sequence");
}

async function advanceScopeSequence(
  client: SqlClient,
  scope: EventScope,
  sequence: number,
): Promise<void> {
  const result = await client.query(ADVANCE_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL, [
    scope.scopeType,
    scope.scopeId,
    sequence,
  ]);
  if (result.rowCount !== 1) {
    throw new EventStoreError(
      "cursor_conflict",
      "Canonical event scope sequence could not be advanced",
    );
  }
}

async function findExistingIdempotentEvent(
  client: SqlClient,
  input: AppendEventInput,
): Promise<PlatformEvent | null> {
  const result = await client.query<CanonicalEventRow>(READ_IDEMPOTENT_EVENT_SQL, [
    input.scopeType,
    input.scopeId,
    input.idempotencyKey,
  ]);
  const row = result.rows[0];
  return row ? mapCanonicalEventRow(row) : null;
}

function resolveIdempotentRetry(
  existing: PlatformEvent,
  input: AppendEventInput,
): PlatformEvent {
  if (
    createStableEventFingerprint(toAppendInput(existing)) !==
    createStableEventFingerprint(input)
  ) {
    throw new EventStoreError(
      "idempotency_conflict",
      "Idempotency key was already used for a different event",
    );
  }
  return existing;
}

function createEvent(
  input: AppendEventInput,
  sequence: number,
  clock: EventStoreClock,
  idGenerator: EventStoreIdGenerator,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...input,
    eventId: idGenerator.nextEventId(),
    cursor: idGenerator.nextCursor(),
    sequence,
    createdAt: clock.now(),
  });
}

async function insertEvent(
  client: SqlClient,
  event: PlatformEvent,
): Promise<PlatformEvent> {
  try {
    const result = await client.query<CanonicalEventRow>(INSERT_EVENT_SQL, [
      event.eventId,
      event.scopeType,
      event.scopeId,
      event.threadId,
      event.runId,
      event.workspaceId,
      readArtifactId(event),
      readProviderId(event),
      event.sequence,
      event.cursor,
      event.idempotencyKey,
      event.type,
      JSON.stringify(event.payload),
      event.schemaVersion,
      event.producer.kind,
      event.producer.id,
      event.createdAt,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Canonical event insert returned no row: ${event.eventId}`);
    }
    return mapCanonicalEventRow(row);
  } catch (error) {
    throw mapInsertError(error);
  }
}

function mapInsertError(error: unknown): Error {
  const constraint = readPostgresUniqueConstraint(error);
  if (constraint === "canonical_events_event_id_unique") {
    return new EventStoreError("event_id_conflict", "Event ID already exists");
  }
  if (constraint === "canonical_events_cursor_unique") {
    return new EventStoreError("cursor_conflict", "Event cursor already exists");
  }
  if (constraint === "canonical_events_scope_idempotency_idx") {
    return new EventStoreError(
      "idempotency_conflict",
      "Idempotency key was already used for a different event",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readPostgresUniqueConstraint(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  return error.code === POSTGRES_UNIQUE_VIOLATION_CODE &&
    typeof error.constraint === "string"
    ? error.constraint
    : null;
}

function mapCanonicalEventRow(row: CanonicalEventRow): PlatformEvent {
  return PlatformEventSchema.parse({
    eventId: requireString(row.event_id, "event_id"),
    scopeType: requireString(row.scope_type, "scope_type"),
    scopeId: requireString(row.scope_id, "scope_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    runId: row.run_id ?? null,
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    sequence: toNumber(row.sequence, "sequence"),
    cursor: requireString(row.cursor, "cursor"),
    idempotencyKey: requireString(row.idempotency_key, "idempotency_key"),
    type: requireString(row.event_type, "event_type"),
    payload: parsePayload(row.payload_json),
    producer: {
      kind: requireString(row.producer_kind, "producer_kind"),
      id: row.producer_id ?? null,
    },
    schemaVersion: toNumber(row.schema_version, "schema_version"),
    createdAt: toIsoString(row.created_at, "created_at"),
  });
}

function toAppendInput(event: PlatformEvent): AppendEventInput {
  const { eventId, sequence, cursor, createdAt, ...input } = event;
  void eventId;
  void sequence;
  void cursor;
  void createdAt;
  return input;
}

function parseReplayCursor(afterCursor: EventCursor | null): EventCursor | null {
  if (afterCursor === null) {
    return null;
  }
  return EventCursorSchema.parse(afterCursor);
}

function validateReplayLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT) {
    throw new EventStoreError(
      "invalid_replay_limit",
      `Replay limit must be between 1 and ${MAX_REPLAY_LIMIT}`,
    );
  }
}

function readArtifactId(event: PlatformEvent): string | null {
  return event.scopeType === "artifact" ? event.scopeId : null;
}

function readProviderId(event: PlatformEvent): string | null {
  void event;
  return null;
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return JSON.parse(value) as unknown;
}

function requireString(value: unknown, columnName: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a string`);
}

function toIsoString(value: unknown, columnName: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a timestamp`);
}

function toNumber(value: unknown, columnName: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error(`Expected ${columnName} to be numeric`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CANONICAL_EVENT_COLUMNS = `
  event_id,
  scope_type,
  scope_id,
  thread_id,
  run_id,
  workspace_id,
  sequence,
  cursor,
  idempotency_key,
  event_type,
  payload_json,
  schema_version,
  producer_kind,
  producer_id,
  created_at
`;

const READ_IDEMPOTENT_EVENT_SQL = `
  SELECT ${CANONICAL_EVENT_COLUMNS}
  FROM canonical_events
  WHERE scope_type = $1
    AND scope_id = $2
    AND idempotency_key = $3
  LIMIT 1
`;

const READ_CURSOR_SEQUENCE_SQL = `
  SELECT sequence
  FROM canonical_events
  WHERE scope_type = $1
    AND scope_id = $2
    AND cursor = $3
  LIMIT 1
`;

const INSERT_EVENT_SQL = `
  INSERT INTO canonical_events (
    event_id,
    scope_type,
    scope_id,
    thread_id,
    run_id,
    workspace_id,
    artifact_id,
    provider_id,
    sequence,
    cursor,
    idempotency_key,
    event_type,
    payload_json,
    schema_version,
    producer_kind,
    producer_id,
    created_at
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13::jsonb,
    $14,
    $15,
    $16,
    $17
  )
  RETURNING ${CANONICAL_EVENT_COLUMNS}
`;

const REPLAY_EVENTS_SQL = `
  SELECT ${CANONICAL_EVENT_COLUMNS}
  FROM canonical_events
  WHERE scope_type = $1
    AND scope_id = $2
    AND sequence > $3
  ORDER BY sequence ASC
  LIMIT $4
`;
