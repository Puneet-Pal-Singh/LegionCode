import { buildRuntimeEventInboxStatusSqlList } from "../runtime-events/types.js";
import type { SqlMigration } from "./types.js";

const RUNTIME_EVENT_INBOX_STATUS_SQL_LIST =
  buildRuntimeEventInboxStatusSqlList();

export const runtimeEventInboxMigration: SqlMigration = {
  id: "0001_runtime_event_inbox",
  description: "Create runtime event inbox for signed secure runtime events",
  statements: [
    `
      CREATE EXTENSION IF NOT EXISTS pgcrypto
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_event_inbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json JSONB NOT NULL,
        payload_schema_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        error_message TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        CONSTRAINT runtime_event_inbox_status_check
          CHECK (status IN (${RUNTIME_EVENT_INBOX_STATUS_SQL_LIST})),
        CONSTRAINT runtime_event_inbox_payload_schema_version_check
          CHECK (payload_schema_version > 0)
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_event_inbox_source_idempotency_key_idx
        ON runtime_event_inbox (source, idempotency_key)
    `,
    `
      CREATE INDEX IF NOT EXISTS runtime_event_inbox_status_received_at_idx
        ON runtime_event_inbox (status, received_at)
    `,
  ],
};

export const persistenceMigrations = [runtimeEventInboxMigration] as const;
