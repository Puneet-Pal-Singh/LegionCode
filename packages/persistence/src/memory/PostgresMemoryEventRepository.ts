import type { JsonValue } from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import {
  parseJsonField,
  requireRow,
  requireString,
  toJsonParam,
  toIsoString,
} from "../lib/rowMappers.js";
import type {
  AppendMemoryEventInput,
  MemoryEventRecord,
  MemoryEventRepository,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class PostgresMemoryEventRepository implements MemoryEventRepository {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async appendEvent(input: AppendMemoryEventInput): Promise<MemoryEventRecord> {
    const now = this.clock.now();
    const result = await this.client.query<MemoryEventRow>(
      APPEND_MEMORY_EVENT_SQL,
      [
        input.userId,
        input.sessionId,
        input.runId ?? null,
        input.eventType,
        toJsonParam(input.payload),
        input.idempotencyKey ?? null,
        now,
      ],
    );

    return mapMemoryEventRow(requireRow(result.rows[0], "memory_events"));
  }

  async listEventsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<MemoryEventRecord[]> {
    const result = await this.client.query<MemoryEventRow>(
      LIST_MEMORY_EVENTS_SQL,
      [sessionId, userId ?? null],
    );

    return result.rows.map(mapMemoryEventRow);
  }

  async transaction<T>(
    callback: (repository: MemoryEventRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(
        new PostgresMemoryEventRepository(tx, this.clock),
      );
    });
  }
}

interface MemoryEventRow extends SqlRow {
  id?: string;
  user_id?: string;
  session_id?: string;
  run_id?: string | null;
  event_type?: string;
  payload_json?: JsonValue | string | null;
  idempotency_key?: string | null;
  created_at?: string | Date;
}

function mapMemoryEventRow(row: MemoryEventRow): MemoryEventRecord {
  return {
    id: requireString(row.id, "id"),
    userId: requireString(row.user_id, "user_id"),
    sessionId: requireString(row.session_id, "session_id"),
    runId: row.run_id ?? null,
    eventType: requireString(row.event_type, "event_type"),
    payload: parseJsonField(row.payload_json, "memory_events.payload_json"),
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: toIsoString(row.created_at),
  };
}

const APPEND_MEMORY_EVENT_SQL = `
  INSERT INTO memory_events (
    user_id,
    session_id,
    run_id,
    event_type,
    payload_json,
    idempotency_key,
    created_at
  )
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
  ON CONFLICT (session_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING
    id,
    user_id,
    session_id,
    run_id,
    event_type,
    payload_json,
    idempotency_key,
    created_at
`;

const LIST_MEMORY_EVENTS_SQL = `
  SELECT
    id,
    user_id,
    session_id,
    run_id,
    event_type,
    payload_json,
    idempotency_key,
    created_at
  FROM memory_events
  WHERE session_id = $1
    AND ($2::uuid IS NULL OR user_id = $2::uuid)
  ORDER BY created_at ASC
`;
