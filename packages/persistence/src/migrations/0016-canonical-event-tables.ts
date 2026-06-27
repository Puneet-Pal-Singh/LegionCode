import { buildCanonicalEventScopeTypeSqlList } from "../canonical-events/types.js";
import type { SqlMigration } from "./types.js";

const CANONICAL_EVENT_SCOPE_TYPE_SQL_LIST =
  buildCanonicalEventScopeTypeSqlList();

export const canonicalEventTablesMigration: SqlMigration = {
  id: "0016_canonical_event_tables",
  description: "Create canonical append-only event tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS canonical_event_scope_sequences (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        next_sequence BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_type, scope_id),
        CONSTRAINT canonical_event_scope_sequences_scope_type_check
          CHECK (scope_type IN (${CANONICAL_EVENT_SCOPE_TYPE_SQL_LIST})),
        CONSTRAINT canonical_event_scope_sequences_next_sequence_check
          CHECK (next_sequence > 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS canonical_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        run_id TEXT,
        workspace_id TEXT NOT NULL,
        artifact_id TEXT,
        provider_id TEXT,
        sequence BIGINT NOT NULL,
        global_sequence BIGSERIAL NOT NULL,
        cursor TEXT NOT NULL,
        idempotency_key TEXT,
        event_type TEXT NOT NULL,
        payload_json JSONB NOT NULL,
        schema_version INTEGER NOT NULL,
        producer_kind TEXT NOT NULL,
        producer_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_events_event_id_unique
          UNIQUE (event_id),
        CONSTRAINT canonical_events_cursor_unique
          UNIQUE (cursor),
        CONSTRAINT canonical_events_scope_sequence_unique
          UNIQUE (scope_type, scope_id, sequence),
        CONSTRAINT canonical_events_scope_type_check
          CHECK (scope_type IN (${CANONICAL_EVENT_SCOPE_TYPE_SQL_LIST})),
        CONSTRAINT canonical_events_sequence_check
          CHECK (sequence > 0),
        CONSTRAINT canonical_events_schema_version_check
          CHECK (schema_version > 0)
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS canonical_events_scope_idempotency_idx
        ON canonical_events (scope_type, scope_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_events_scope_sequence_idx
        ON canonical_events (scope_type, scope_id, sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_events_thread_sequence_idx
        ON canonical_events (thread_id, global_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_events_workspace_sequence_idx
        ON canonical_events (workspace_id, global_sequence)
    `,
  ],
};
