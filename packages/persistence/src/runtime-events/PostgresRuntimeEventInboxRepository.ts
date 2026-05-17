import type { InternalRuntimeEventRequest } from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import { mapRuntimeEventInboxRow } from "./row-mapping.js";
import type {
  RuntimeEventInboxAcceptResult,
  RuntimeEventInboxEntry,
  RuntimeEventInboxRepository,
} from "./types.js";

interface RuntimeEventInboxAcceptRow extends SqlRow {
  inserted: boolean;
}

export class PostgresRuntimeEventInboxRepository
  implements RuntimeEventInboxRepository
{
  constructor(private readonly client: SqlClient) {}

  async accept(
    event: InternalRuntimeEventRequest,
  ): Promise<RuntimeEventInboxAcceptResult> {
    const result = await this.client.query<RuntimeEventInboxAcceptRow>(
      ACCEPT_RUNTIME_EVENT_SQL,
      [
        event.source,
        event.eventType,
        event.idempotencyKey,
        JSON.stringify(event.payload),
        event.payloadSchemaVersion,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Runtime event inbox accept returned no row");
    }

    return {
      entry: mapRuntimeEventInboxRow(row),
      inserted: row.inserted,
    };
  }

  async markProcessed(
    entryId: string,
    processedAt: string,
  ): Promise<RuntimeEventInboxEntry> {
    const result = await this.client.query(MARK_RUNTIME_EVENT_PROCESSED_SQL, [
      entryId,
      processedAt,
    ]);
    return mapRuntimeEventInboxRow(readReturnedRow(result.rows[0], entryId));
  }

  async markFailed(
    entryId: string,
    errorMessage: string,
  ): Promise<RuntimeEventInboxEntry> {
    const result = await this.client.query(MARK_RUNTIME_EVENT_FAILED_SQL, [
      entryId,
      errorMessage,
    ]);
    return mapRuntimeEventInboxRow(readReturnedRow(result.rows[0], entryId));
  }
}

function readReturnedRow(
  row: SqlRow | undefined,
  entryId: string,
): SqlRow {
  if (!row) {
    throw new Error(`Runtime event inbox entry not found: ${entryId}`);
  }
  return row;
}

const ACCEPT_RUNTIME_EVENT_SQL = `
  WITH inserted AS (
    INSERT INTO runtime_event_inbox (
      source,
      event_type,
      idempotency_key,
      payload_json,
      payload_schema_version
    )
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (source, idempotency_key) DO NOTHING
    RETURNING
      id,
      source,
      event_type,
      idempotency_key,
      payload_json,
      payload_schema_version,
      status,
      error_message,
      received_at,
      processed_at,
      true AS inserted
  )
  SELECT * FROM inserted
  UNION ALL
  SELECT
    id,
    source,
    event_type,
    idempotency_key,
    payload_json,
    payload_schema_version,
    status,
    error_message,
    received_at,
    processed_at,
    false AS inserted
  FROM runtime_event_inbox
  WHERE source = $1
    AND idempotency_key = $3
    AND NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
`;

const RETURNING_RUNTIME_EVENT_INBOX_COLUMNS = `
  id,
  source,
  event_type,
  idempotency_key,
  payload_json,
  payload_schema_version,
  status,
  error_message,
  received_at,
  processed_at
`;

const MARK_RUNTIME_EVENT_PROCESSED_SQL = `
  UPDATE runtime_event_inbox
  SET
    status = 'processed',
    error_message = NULL,
    processed_at = $2
  WHERE id = $1
  RETURNING ${RETURNING_RUNTIME_EVENT_INBOX_COLUMNS}
`;

const MARK_RUNTIME_EVENT_FAILED_SQL = `
  UPDATE runtime_event_inbox
  SET
    status = 'failed',
    error_message = $2,
    processed_at = NULL
  WHERE id = $1
  RETURNING ${RETURNING_RUNTIME_EVENT_INBOX_COLUMNS}
`;
