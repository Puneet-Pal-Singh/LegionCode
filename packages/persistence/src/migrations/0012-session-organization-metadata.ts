import { buildChatTitleSourceSqlList } from "../sessions/types.js";
import type { SqlMigration } from "./types.js";

const CHAT_TITLE_SOURCE_SQL_LIST = buildChatTitleSourceSqlList();

export const sessionOrganizationMetadataMigration: SqlMigration = {
  id: "0012_session_organization_metadata",
  description: "Add session title ownership, pin, and archive metadata",
  statements: [
    `
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'generated'
    `,
    `
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE sessions
        DROP CONSTRAINT IF EXISTS sessions_title_source_check
    `,
    `
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_title_source_check
        CHECK (title_source IN (${CHAT_TITLE_SOURCE_SQL_LIST}))
    `,
    `
      CREATE INDEX IF NOT EXISTS sessions_user_archived_updated_idx
        ON sessions (user_id, archived_at, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS sessions_user_pinned_idx
        ON sessions (user_id, pinned_at DESC)
        WHERE pinned_at IS NOT NULL AND archived_at IS NULL
    `,
  ],
};
