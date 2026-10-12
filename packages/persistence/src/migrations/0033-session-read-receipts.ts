import type { SqlMigration } from "./types.js";

export const sessionReadReceiptsMigration: SqlMigration = {
  id: "0033_session_read_receipts",
  description: "Bind existing viewer read receipts to hosted sessions",
  statements: [
    `ALTER TABLE thread_read_receipts DROP CONSTRAINT IF EXISTS thread_read_receipts_pkey`,
    `ALTER TABLE thread_read_receipts ALTER COLUMN thread_id DROP NOT NULL`,
    `ALTER TABLE thread_read_receipts ADD COLUMN IF NOT EXISTS session_id UUID`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_read_receipts_session_fk') THEN ALTER TABLE thread_read_receipts ADD CONSTRAINT thread_read_receipts_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_read_receipts_thread_viewer_unique') THEN ALTER TABLE thread_read_receipts ADD CONSTRAINT thread_read_receipts_thread_viewer_unique UNIQUE (thread_id, viewer_id); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_read_receipts_session_viewer_unique') THEN ALTER TABLE thread_read_receipts ADD CONSTRAINT thread_read_receipts_session_viewer_unique UNIQUE (session_id, viewer_id); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thread_read_receipts_owner_check') THEN ALTER TABLE thread_read_receipts ADD CONSTRAINT thread_read_receipts_owner_check CHECK ((thread_id IS NOT NULL) <> (session_id IS NOT NULL)); END IF; END $$`,
  ],
};
