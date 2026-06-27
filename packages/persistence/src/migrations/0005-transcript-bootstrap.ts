import {
  buildMessagePartTypeSqlList,
  buildMessageRoleSqlList,
  buildChatTitleSourceSqlList,
  buildSessionStatusSqlList,
  buildTaskStatusSqlList,
} from "../sessions/types.js";
import type { SqlMigration } from "./types.js";

const TASK_STATUS_SQL_LIST = buildTaskStatusSqlList();
const SESSION_STATUS_SQL_LIST = buildSessionStatusSqlList();
const CHAT_TITLE_SOURCE_SQL_LIST = buildChatTitleSourceSqlList();
const MESSAGE_ROLE_SQL_LIST = buildMessageRoleSqlList();
const MESSAGE_PART_TYPE_SQL_LIST = buildMessagePartTypeSqlList();

export const transcriptBootstrapMigration: SqlMigration = {
  id: "0005_transcript_bootstrap",
  description:
    "Create canonical task, session, message, and message part tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at TIMESTAMPTZ,
        CONSTRAINT tasks_status_check
          CHECK (status IN (${TASK_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS tasks_user_updated_idx
        ON tasks (user_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS tasks_workspace_idx
        ON tasks (workspace_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'generated',
        repository TEXT,
        active_run_id TEXT,
        mode TEXT NOT NULL DEFAULT 'build',
        status TEXT NOT NULL DEFAULT 'idle',
        last_sequence BIGINT NOT NULL DEFAULT 0,
        pinned_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT sessions_status_check
          CHECK (status IN (${SESSION_STATUS_SQL_LIST})),
        CONSTRAINT sessions_title_source_check
          CHECK (title_source IN (${CHAT_TITLE_SOURCE_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS sessions_user_updated_idx
        ON sessions (user_id, updated_at)
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
    `
      CREATE INDEX IF NOT EXISTS sessions_task_idx
        ON sessions (task_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS sessions_workspace_idx
        ON sessions (workspace_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        role TEXT NOT NULL,
        client_message_id TEXT,
        dedupe_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT messages_role_check
          CHECK (role IN (${MESSAGE_ROLE_SQL_LIST}))
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS messages_id_session_idx
        ON messages (id, session_id)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS messages_session_dedupe_idx
        ON messages (session_id, dedupe_key)
    `,
    `
      CREATE INDEX IF NOT EXISTS messages_session_created_idx
        ON messages (session_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS messages_run_idx
        ON messages (run_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS message_parts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id UUID NOT NULL,
        run_id TEXT,
        part_type TEXT NOT NULL,
        session_sequence BIGINT NOT NULL,
        content_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT message_parts_message_session_fk
          FOREIGN KEY (message_id, session_id) REFERENCES messages(id, session_id) ON DELETE CASCADE,
        CONSTRAINT message_parts_type_check
          CHECK (part_type IN (${MESSAGE_PART_TYPE_SQL_LIST}))
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS message_parts_session_sequence_idx
        ON message_parts (session_id, session_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS message_parts_message_idx
        ON message_parts (message_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS message_parts_run_idx
        ON message_parts (run_id)
    `,
  ],
};
