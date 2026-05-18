import { buildRuntimeEventInboxStatusSqlList } from "../runtime-events/types.js";
import { identitySessionBootstrapMigration } from "./0002-identity-session-bootstrap.js";
import { workspaceBootstrapMigration } from "./0003-workspace-bootstrap.js";
import { providerStateBootstrapMigration } from "./0004-provider-state-bootstrap.js";
import { transcriptBootstrapMigration } from "./0005-transcript-bootstrap.js";
import { runBootstrapMigration } from "./0006-run-bootstrap.js";
import { contextMemoryPermissionsBootstrapMigration } from "./0007-context-memory-permissions-bootstrap.js";
import { artifactMetadataBootstrapMigration } from "./0008-artifact-metadata-bootstrap.js";
import { artifactRestoreLookupIndexMigration } from "./0009-artifact-restore-lookup-index.js";
import { sessionsActiveRunForeignKeyMigration } from "./0010-sessions-active-run-fk.js";
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

export const persistenceMigrations = [
  runtimeEventInboxMigration,
  identitySessionBootstrapMigration,
  workspaceBootstrapMigration,
  providerStateBootstrapMigration,
  transcriptBootstrapMigration,
  runBootstrapMigration,
  contextMemoryPermissionsBootstrapMigration,
  artifactMetadataBootstrapMigration,
  artifactRestoreLookupIndexMigration,
  sessionsActiveRunForeignKeyMigration,
] as const;
