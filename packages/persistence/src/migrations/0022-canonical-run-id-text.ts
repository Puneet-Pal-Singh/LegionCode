import type { SqlMigration } from "./types.js";

export const canonicalRunIdTextMigration: SqlMigration = {
  id: "0022_canonical_run_id_text",
  description: "Align run identity columns with canonical run_ identifiers",
  statements: [
    `ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_active_run_id_fk`,
    `ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_active_run_id_fkey`,
    `ALTER TABLE run_events DROP CONSTRAINT IF EXISTS run_events_run_id_runs_id_fk`,
    `ALTER TABLE run_events DROP CONSTRAINT IF EXISTS run_events_run_id_fkey`,
    `ALTER TABLE run_steps DROP CONSTRAINT IF EXISTS run_steps_run_id_runs_id_fk`,
    `ALTER TABLE run_steps DROP CONSTRAINT IF EXISTS run_steps_run_id_fkey`,
    `ALTER TABLE context_snapshots DROP CONSTRAINT IF EXISTS context_snapshots_run_id_runs_id_fk`,
    `ALTER TABLE context_snapshots DROP CONSTRAINT IF EXISTS context_snapshots_run_id_fkey`,
    `ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_run_id_runs_id_fk`,
    `ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_run_id_fkey`,
    `ALTER TABLE permission_requests DROP CONSTRAINT IF EXISTS permission_requests_run_id_runs_id_fk`,
    `ALTER TABLE permission_requests DROP CONSTRAINT IF EXISTS permission_requests_run_id_fkey`,
    `ALTER TABLE artifact_events DROP CONSTRAINT IF EXISTS artifact_events_run_id_runs_id_fk`,
    `ALTER TABLE artifact_events DROP CONSTRAINT IF EXISTS artifact_events_run_id_fkey`,
    `ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_run_id_runs_id_fk`,
    `ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_run_id_fkey`,
    `ALTER TABLE runs ALTER COLUMN id SET DATA TYPE text USING id::text`,
    `ALTER TABLE sessions ALTER COLUMN active_run_id SET DATA TYPE text USING active_run_id::text`,
    `ALTER TABLE messages ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE message_parts ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE run_events ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE run_steps ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE context_snapshots ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE memory_events ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE permission_requests ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE artifact_events ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `ALTER TABLE artifacts ALTER COLUMN run_id SET DATA TYPE text USING run_id::text`,
    `
      ALTER TABLE sessions
      ADD CONSTRAINT sessions_active_run_id_fk
      FOREIGN KEY (active_run_id)
      REFERENCES runs(id)
      ON DELETE set null
      ON UPDATE no action
      NOT VALID
    `,
    `ALTER TABLE sessions VALIDATE CONSTRAINT sessions_active_run_id_fk`,
    `
      ALTER TABLE run_events
      ADD CONSTRAINT run_events_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE cascade
      ON UPDATE no action
    `,
    `
      ALTER TABLE run_steps
      ADD CONSTRAINT run_steps_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE cascade
      ON UPDATE no action
    `,
    `
      ALTER TABLE context_snapshots
      ADD CONSTRAINT context_snapshots_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE set null
      ON UPDATE no action
    `,
    `
      ALTER TABLE memory_events
      ADD CONSTRAINT memory_events_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE set null
      ON UPDATE no action
    `,
    `
      ALTER TABLE permission_requests
      ADD CONSTRAINT permission_requests_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE cascade
      ON UPDATE no action
    `,
    `
      ALTER TABLE artifact_events
      ADD CONSTRAINT artifact_events_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE cascade
      ON UPDATE no action
    `,
    `
      ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_run_id_runs_id_fk
      FOREIGN KEY (run_id)
      REFERENCES runs(id)
      ON DELETE cascade
      ON UPDATE no action
    `,
  ],
};
