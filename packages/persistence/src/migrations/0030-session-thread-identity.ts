import type { SqlMigration } from "./types.js";

export const sessionThreadIdentityMigration: SqlMigration = {
  id: "0030_session_thread_identity",
  description: "Persist the server-issued thread identity with each session",
  statements: [
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thread_id TEXT`,
    `CREATE INDEX IF NOT EXISTS sessions_thread_id_idx ON sessions (thread_id) WHERE thread_id IS NOT NULL`,
  ],
};
