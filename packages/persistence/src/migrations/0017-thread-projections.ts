import {
  ThreadItemRoleSchema,
  ThreadItemStatusSchema,
  ThreadItemTypeSchema,
  ThreadStatusSchema,
  ThreadTitleSourceSchema,
} from "@repo/platform-protocol";
import { buildSqlList } from "../sessions/types.js";
import type { SqlMigration } from "./types.js";

const THREAD_STATUS_SQL_LIST = buildSqlList(ThreadStatusSchema.options);
const THREAD_TITLE_SOURCE_SQL_LIST = buildSqlList(
  ThreadTitleSourceSchema.options,
);
const THREAD_ITEM_ROLE_SQL_LIST = buildSqlList(ThreadItemRoleSchema.options);
const THREAD_ITEM_STATUS_SQL_LIST = buildSqlList(
  ThreadItemStatusSchema.options,
);
const THREAD_ITEM_TYPE_SQL_LIST = buildSqlList(ThreadItemTypeSchema.options);

export const threadProjectionsMigration: SqlMigration = {
  id: "0017_thread_projections",
  description: "Create canonical thread projection tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS canonical_thread_projections (
        thread_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL,
        status TEXT NOT NULL,
        pinned_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,
        active_run_id TEXT,
        active_leaf_item_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_event_sequence BIGINT NOT NULL,
        last_cursor TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_thread_projections_status_check
          CHECK (status IN (${THREAD_STATUS_SQL_LIST})),
        CONSTRAINT canonical_thread_projections_title_source_check
          CHECK (title_source IN (${THREAD_TITLE_SOURCE_SQL_LIST})),
        CONSTRAINT canonical_thread_projections_last_event_sequence_check
          CHECK (last_event_sequence > 0),
        CONSTRAINT canonical_thread_projections_version_check
          CHECK (projection_version > 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS canonical_thread_item_projections (
        item_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT,
        turn_id TEXT,
        parent_item_id TEXT,
        branch_id TEXT,
        role TEXT NOT NULL,
        item_type TEXT NOT NULL,
        status TEXT NOT NULL,
        content_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        event_sequence BIGINT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_cursor TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_thread_item_projections_thread_fk
          FOREIGN KEY (thread_id)
          REFERENCES canonical_thread_projections (thread_id)
          ON DELETE CASCADE,
        CONSTRAINT canonical_thread_item_projections_role_check
          CHECK (role IN (${THREAD_ITEM_ROLE_SQL_LIST})),
        CONSTRAINT canonical_thread_item_projections_status_check
          CHECK (status IN (${THREAD_ITEM_STATUS_SQL_LIST})),
        CONSTRAINT canonical_thread_item_projections_type_check
          CHECK (item_type IN (${THREAD_ITEM_TYPE_SQL_LIST})),
        CONSTRAINT canonical_thread_item_projections_event_sequence_check
          CHECK (event_sequence > 0),
        CONSTRAINT canonical_thread_item_projections_version_check
          CHECK (projection_version > 0)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_thread_projections_user_updated_idx
        ON canonical_thread_projections (user_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_thread_projections_workspace_updated_idx
        ON canonical_thread_projections (workspace_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_thread_item_projections_thread_sequence_idx
        ON canonical_thread_item_projections (thread_id, event_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_thread_item_projections_run_sequence_idx
        ON canonical_thread_item_projections (run_id, event_sequence)
    `,
  ],
};
