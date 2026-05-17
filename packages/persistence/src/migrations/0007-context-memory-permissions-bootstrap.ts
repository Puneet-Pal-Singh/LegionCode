import {
  buildPermissionRequestStatusSqlList,
  buildPermissionDecisionKindSqlList,
} from "../permissions/types.js";
import type { SqlMigration } from "./types.js";

const PERMISSION_REQUEST_STATUS_SQL_LIST =
  buildPermissionRequestStatusSqlList();
const PERMISSION_DECISION_KIND_SQL_LIST =
  buildPermissionDecisionKindSqlList();

export const contextMemoryPermissionsBootstrapMigration: SqlMigration = {
  id: "0007_context_memory_permissions_bootstrap",
  description:
    "Create context snapshots, memory events, and permission tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS memory_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        payload_json JSONB,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS memory_events_session_created_idx
        ON memory_events (session_id, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS memory_events_session_idempotency_idx
        ON memory_events (session_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `,
    `
      CREATE TABLE IF NOT EXISTS context_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
        snapshot_kind TEXT NOT NULL,
        r2_object_key TEXT,
        payload_size_bytes INTEGER,
        token_count INTEGER,
        trigger_reason TEXT,
        source_message_range_json JSONB,
        summary_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        replacement_history_r2_object_key TEXT,
        usage_before_json JSONB,
        usage_after_json JSONB,
        validation_json JSONB,
        model_info_json JSONB,
        media_artifacts_json JSONB,
        continuity_state_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS context_snapshots_session_idx
        ON context_snapshots (session_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS context_snapshots_run_idx
        ON context_snapshots (run_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS context_snapshot_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        context_snapshot_id UUID NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_range_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS snapshot_sources_snapshot_idx
        ON context_snapshot_sources (context_snapshot_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS snapshot_sources_type_id_idx
        ON context_snapshot_sources (source_type, source_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS permission_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        request_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json JSONB,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ,
        CONSTRAINT permission_requests_status_check
          CHECK (status IN (${PERMISSION_REQUEST_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS permission_requests_run_created_idx
        ON permission_requests (run_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS permission_requests_user_status_created_idx
        ON permission_requests (user_id, status, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS permission_decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_request_id UUID NOT NULL REFERENCES permission_requests(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        decision TEXT NOT NULL,
        payload_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT permission_decisions_kind_check
          CHECK (decision IN (${PERMISSION_DECISION_KIND_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS permission_decisions_request_created_idx
        ON permission_decisions (permission_request_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS permission_decisions_user_created_idx
        ON permission_decisions (user_id, created_at DESC)
    `,
  ],
};
