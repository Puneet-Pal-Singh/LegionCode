import type { SqlMigration } from "./types.js";

const ARTIFACT_KINDS_0008 = ["git_patch", "file_snapshot"] as const;
const ARTIFACT_STATUSES_0008 = [
  "pending",
  "stored",
  "capture_failed",
  "restore_in_progress",
  "restored",
  "anchored",
  "discarded",
  "expired",
  "restore_failed",
  "requires_user_resolution",
] as const;
const ARTIFACT_EVENT_TYPES_0008 = [
  "capture_started",
  "r2_write_succeeded",
  "metadata_commit_succeeded",
  "capture_failed",
  "restore_attempted",
  "restored",
  "restore_failed",
  "requires_user_resolution",
  "anchored",
  "discarded",
  "expired",
] as const;

const ARTIFACT_KIND_SQL_LIST = buildSqlList(ARTIFACT_KINDS_0008);
const ARTIFACT_STATUS_SQL_LIST = buildSqlList(ARTIFACT_STATUSES_0008);
const ARTIFACT_EVENT_TYPE_SQL_LIST = buildSqlList(ARTIFACT_EVENT_TYPES_0008);

export const artifactMetadataBootstrapMigration: SqlMigration = {
  id: "0008_artifact_metadata_bootstrap",
  description: "Create canonical edit artifact metadata tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS artifacts (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        repo_owner TEXT,
        repo_name TEXT,
        repo_url TEXT,
        branch TEXT,
        base_commit_sha TEXT,
        head_commit_sha TEXT,
        artifact_kind TEXT NOT NULL,
        r2_object_key TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT artifacts_kind_check
          CHECK (artifact_kind IN (${ARTIFACT_KIND_SQL_LIST})),
        CONSTRAINT artifacts_status_check
          CHECK (status IN (${ARTIFACT_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_r2_object_key_idx
        ON artifacts (r2_object_key)
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_user_workspace_updated_idx
        ON artifacts (user_id, workspace_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_run_status_updated_idx
        ON artifacts (run_id, status, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_expiry_status_idx
        ON artifacts (expires_at, status)
    `,
    `
      CREATE TABLE IF NOT EXISTS artifact_events (
        id UUID PRIMARY KEY,
        artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT artifact_events_type_check
          CHECK (event_type IN (${ARTIFACT_EVENT_TYPE_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS artifact_events_artifact_created_idx
        ON artifact_events (artifact_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS artifact_events_run_created_idx
        ON artifact_events (run_id, created_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS artifact_changed_files (
        artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        additions INTEGER,
        deletions INTEGER,
        metadata_json JSONB
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS artifact_changed_files_artifact_path_idx
        ON artifact_changed_files (artifact_id, path)
    `,
  ],
};

function buildSqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}
