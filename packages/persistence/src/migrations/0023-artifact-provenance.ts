import type { SqlMigration } from "./types.js";

export const artifactProvenanceMigration: SqlMigration = {
  id: "0023_artifact_provenance",
  description: "Persist server-owned turn identity on edit artifacts",
  statements: [
    `
      ALTER TABLE artifacts
        ADD COLUMN IF NOT EXISTS thread_id TEXT,
        ADD COLUMN IF NOT EXISTS turn_id TEXT,
        ADD COLUMN IF NOT EXISTS run_attempt_id TEXT
    `,
    `
      CREATE INDEX IF NOT EXISTS artifacts_provenance_lookup_idx
        ON artifacts (
          run_id,
          workspace_id,
          thread_id,
          turn_id,
          run_attempt_id,
          assistant_message_id,
          created_at DESC
        )
    `,
  ],
};
