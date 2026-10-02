import type { SqlMigration } from "./types.js";

export const sessionTitleStatusMigration: SqlMigration = {
  id: "0031_session_title_status",
  description:
    "Persist title job settlement independently of title source and run state",
  statements: [
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_status TEXT NOT NULL DEFAULT 'ready'`,
    `ALTER TABLE sessions ADD CONSTRAINT sessions_title_status_check CHECK (title_status IN ('pending', 'ready', 'failed'))`,
  ],
};
