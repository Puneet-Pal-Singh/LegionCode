import type { SqlMigration } from "./types.js";

const ARTIFACT_STATUS_SQL_LIST = buildSqlList([
  "pending",
  "stored",
  "stored_with_secondary",
  "secondary_write_failed",
  "capture_failed",
  "restore_in_progress",
  "restored",
  "anchored",
  "discarded",
  "expired",
  "restore_failed",
  "requires_user_resolution",
] as const);

const ARTIFACT_EVENT_TYPE_SQL_LIST = buildSqlList([
  "capture_started",
  "r2_write_succeeded",
  "patch_parse_succeeded",
  "patch_parse_failed",
  "cf_artifacts_write_succeeded",
  "cf_artifacts_write_failed",
  "reconciliation_succeeded",
  "reconciliation_failed",
  "metadata_commit_succeeded",
  "capture_failed",
  "restore_attempted",
  "restored",
  "restore_failed",
  "requires_user_resolution",
  "anchored",
  "discarded",
  "expired",
] as const);

export const artifactReviewMetadataMigration: SqlMigration = {
  id: "0013_artifact_review_metadata",
  description: "Add canonical edit artifact review metadata",
  statements: [
    `
      ALTER TABLE artifacts
        ADD COLUMN IF NOT EXISTS user_message_id TEXT,
        ADD COLUMN IF NOT EXISTS assistant_message_id TEXT,
        ADD COLUMN IF NOT EXISTS source_turn_id TEXT,
        ADD COLUMN IF NOT EXISTS capture_sequence INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS patch_parse_status TEXT NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS patch_sha256 TEXT,
        ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'r2_postgres',
        ADD COLUMN IF NOT EXISTS cf_artifact_repo TEXT,
        ADD COLUMN IF NOT EXISTS cf_artifact_commit_sha TEXT,
        ADD COLUMN IF NOT EXISTS cf_artifact_path TEXT,
        ADD COLUMN IF NOT EXISTS storage_reconciliation_status TEXT
    `,
    `
      ALTER TABLE artifacts
        DROP CONSTRAINT IF EXISTS artifacts_status_check
    `,
    `
      ALTER TABLE artifacts
        ADD CONSTRAINT artifacts_status_check
        CHECK (status IN (${ARTIFACT_STATUS_SQL_LIST}))
    `,
    `
      ALTER TABLE artifact_events
        DROP CONSTRAINT IF EXISTS artifact_events_type_check
    `,
    `
      ALTER TABLE artifact_events
        ADD CONSTRAINT artifact_events_type_check
        CHECK (event_type IN (${ARTIFACT_EVENT_TYPE_SQL_LIST}))
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_run_assistant_message_idx
        ON artifacts (run_id, assistant_message_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_run_session_created_idx
        ON artifacts (run_id, session_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_storage_reconciliation_idx
        ON artifacts (storage_reconciliation_status, created_at)
    `,
  ],
};

function buildSqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}
