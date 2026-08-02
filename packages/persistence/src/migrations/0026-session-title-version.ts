import type { SqlMigration } from "./types.js";

export const sessionTitleVersionMigration: SqlMigration = {
  id: "0026_session_title_version",
  description:
    "Add optimistic concurrency metadata for server-owned transcript titles",
  statements: [
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE sessions ADD CONSTRAINT sessions_title_version_positive_check CHECK (title_version > 0)`,
    `ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_title_source_check`,
    `ALTER TABLE sessions ADD CONSTRAINT sessions_title_source_check CHECK (title_source IN ('preview', 'generated', 'user'))`,
  ],
};
