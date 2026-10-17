import type { SqlMigration } from "./types.js";

export const lifecycleEventAppendOrderMigration: SqlMigration = {
  id: "0031_lifecycle_event_append_order",
  description: "Add global append ordering to canonical lifecycle events",
  statements: [
    `ALTER TABLE canonical_lifecycle_events ADD COLUMN IF NOT EXISTS append_order BIGSERIAL NOT NULL`,
    `CREATE INDEX IF NOT EXISTS canonical_lifecycle_events_thread_append_order_idx ON canonical_lifecycle_events (thread_id, append_order DESC) WHERE event_type = 'turn.started'`,
  ],
};
