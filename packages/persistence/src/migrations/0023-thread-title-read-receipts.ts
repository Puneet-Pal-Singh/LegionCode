import type { SqlMigration } from "./types.js";

export const threadTitleReadReceiptsMigration: SqlMigration = {
  id: "0023_thread_title_read_receipts",
  description: "Add durable thread title metadata and viewer read receipts",
  statements: [
    `ALTER TABLE canonical_thread_projections ADD COLUMN IF NOT EXISTS title_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE canonical_thread_projections ADD COLUMN IF NOT EXISTS title_status TEXT NOT NULL DEFAULT 'ready'`,
    `ALTER TABLE canonical_thread_projections ADD COLUMN IF NOT EXISTS last_terminal_turn_id TEXT`,
    `ALTER TABLE canonical_thread_projections DROP CONSTRAINT IF EXISTS canonical_thread_projections_title_status_check`,
    `ALTER TABLE canonical_thread_projections ADD CONSTRAINT canonical_thread_projections_title_status_check CHECK (title_status IN ('pending', 'ready', 'failed'))`,
    `CREATE TABLE IF NOT EXISTS thread_read_receipts (
      thread_id TEXT NOT NULL,
      viewer_id TEXT NOT NULL,
      last_acknowledged_terminal_turn_id TEXT,
      acknowledged_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (thread_id, viewer_id),
      CONSTRAINT thread_read_receipts_thread_fk FOREIGN KEY (thread_id)
        REFERENCES canonical_thread_projections (thread_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS thread_read_receipts_viewer_idx
      ON thread_read_receipts (viewer_id, acknowledged_at)`,
  ],
};
