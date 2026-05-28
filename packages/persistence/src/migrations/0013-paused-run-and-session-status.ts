import type { SqlMigration } from "./types.js";

export const pausedRunAndSessionStatusMigration: SqlMigration = {
  id: "0013_paused_run_and_session_status",
  description: "Allow paused run and session status values",
  statements: [
    `
      ALTER TABLE runs
        DROP CONSTRAINT IF EXISTS runs_status_check
    `,
    `
      ALTER TABLE runs
        ADD CONSTRAINT runs_status_check
          CHECK (status IN ('created', 'running', 'paused', 'completed', 'failed', 'cancelled'))
    `,
    `
      ALTER TABLE sessions
        DROP CONSTRAINT IF EXISTS sessions_status_check
    `,
    `
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_status_check
          CHECK (status IN ('idle', 'running', 'completed', 'paused', 'failed'))
    `,
  ],
};
