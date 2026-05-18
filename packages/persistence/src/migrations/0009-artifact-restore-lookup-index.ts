import type { SqlMigration } from "./types.js";

export const artifactRestoreLookupIndexMigration: SqlMigration = {
  id: "0009_artifact_restore_lookup_index",
  description: "Add run and user scoped edit artifact restore lookup index",
  statements: [
    `
      CREATE INDEX IF NOT EXISTS artifacts_run_user_status_updated_idx
        ON artifacts (run_id, user_id, status, updated_at)
    `,
  ],
};
