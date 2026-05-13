import type { InternalRuntimeEventRequest } from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import { mapRuntimeEventInboxRow } from "./row-mapping.js";
import type {
  RuntimeEventInboxAcceptResult,
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
