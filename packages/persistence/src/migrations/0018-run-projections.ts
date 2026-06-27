import {
  ApprovalDecisionSchema,
  RunModeSchema,
  RunStatusSchema,
  ThreadItemRoleSchema,
  ThreadItemStatusSchema,
  ThreadItemTypeSchema,
} from "@repo/platform-protocol";
import {
  buildApprovalProjectionStatusSqlList,
  buildToolCallProjectionStatusSqlList,
} from "../run-projections/types.js";
import { buildSqlList } from "../sessions/types.js";
import type { SqlMigration } from "./types.js";

const RUN_STATUS_SQL_LIST = buildSqlList(RunStatusSchema.options);
const RUN_MODE_SQL_LIST = buildSqlList(RunModeSchema.options);
const THREAD_ITEM_ROLE_SQL_LIST = buildSqlList(ThreadItemRoleSchema.options);
const THREAD_ITEM_STATUS_SQL_LIST = buildSqlList(
  ThreadItemStatusSchema.options,
);
const THREAD_ITEM_TYPE_SQL_LIST = buildSqlList(ThreadItemTypeSchema.options);
const TOOL_CALL_STATUS_SQL_LIST = buildToolCallProjectionStatusSqlList();
const APPROVAL_STATUS_SQL_LIST = buildApprovalProjectionStatusSqlList();
const APPROVAL_DECISION_SQL_LIST = buildSqlList(
  ApprovalDecisionSchema.options,
);

export const runProjectionsMigration: SqlMigration = {
  id: "0018_run_projections",
  description: "Create canonical run projection tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS canonical_run_projections (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        permission_profile_id TEXT NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_event_sequence BIGINT NOT NULL,
        last_cursor TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_run_projections_status_check
          CHECK (status IN (${RUN_STATUS_SQL_LIST})),
        CONSTRAINT canonical_run_projections_mode_check
          CHECK (mode IN (${RUN_MODE_SQL_LIST})),
        CONSTRAINT canonical_run_projections_last_event_sequence_check
          CHECK (last_event_sequence > 0),
        CONSTRAINT canonical_run_projections_version_check
          CHECK (projection_version > 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS canonical_run_item_projections (
        item_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
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
        CONSTRAINT canonical_run_item_projections_run_fk
          FOREIGN KEY (run_id)
          REFERENCES canonical_run_projections (run_id)
          ON DELETE CASCADE,
        CONSTRAINT canonical_run_item_projections_role_check
          CHECK (role IN (${THREAD_ITEM_ROLE_SQL_LIST})),
        CONSTRAINT canonical_run_item_projections_status_check
          CHECK (status IN (${THREAD_ITEM_STATUS_SQL_LIST})),
        CONSTRAINT canonical_run_item_projections_type_check
          CHECK (item_type IN (${THREAD_ITEM_TYPE_SQL_LIST})),
        CONSTRAINT canonical_run_item_projections_event_sequence_check
          CHECK (event_sequence > 0),
        CONSTRAINT canonical_run_item_projections_version_check
          CHECK (projection_version > 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS canonical_tool_call_projections (
        tool_call_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json JSONB NOT NULL,
        output_json JSONB,
        output_text TEXT NOT NULL DEFAULT '',
        failure_json JSONB,
        requested_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        event_sequence BIGINT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_cursor TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_tool_call_projections_run_fk
          FOREIGN KEY (run_id)
          REFERENCES canonical_run_projections (run_id)
          ON DELETE CASCADE,
        CONSTRAINT canonical_tool_call_projections_status_check
          CHECK (status IN (${TOOL_CALL_STATUS_SQL_LIST})),
        CONSTRAINT canonical_tool_call_projections_event_sequence_check
          CHECK (event_sequence > 0),
        CONSTRAINT canonical_tool_call_projections_version_check
          CHECK (projection_version > 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS canonical_approval_projections (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        item_id TEXT,
        status TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json JSONB NOT NULL,
        metadata_json JSONB NOT NULL,
        decision TEXT,
        decided_by TEXT,
        reason TEXT,
        requested_at TIMESTAMPTZ NOT NULL,
        decided_at TIMESTAMPTZ,
        event_sequence BIGINT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_cursor TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_approval_projections_run_fk
          FOREIGN KEY (run_id)
          REFERENCES canonical_run_projections (run_id)
          ON DELETE CASCADE,
        CONSTRAINT canonical_approval_projections_status_check
          CHECK (status IN (${APPROVAL_STATUS_SQL_LIST})),
        CONSTRAINT canonical_approval_projections_decision_check
          CHECK (decision IS NULL OR decision IN (${APPROVAL_DECISION_SQL_LIST})),
        CONSTRAINT canonical_approval_projections_event_sequence_check
          CHECK (event_sequence > 0),
        CONSTRAINT canonical_approval_projections_version_check
          CHECK (projection_version > 0)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_run_projections_thread_updated_idx
        ON canonical_run_projections (thread_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_run_projections_user_updated_idx
        ON canonical_run_projections (user_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_run_projections_workspace_updated_idx
        ON canonical_run_projections (workspace_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_run_item_projections_run_sequence_idx
        ON canonical_run_item_projections (run_id, event_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_run_item_projections_thread_sequence_idx
        ON canonical_run_item_projections (thread_id, event_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_tool_call_projections_run_sequence_idx
        ON canonical_tool_call_projections (run_id, event_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_tool_call_projections_item_idx
        ON canonical_tool_call_projections (item_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_approval_projections_run_sequence_idx
        ON canonical_approval_projections (run_id, event_sequence)
    `,
    `
      CREATE INDEX IF NOT EXISTS canonical_approval_projections_item_idx
        ON canonical_approval_projections (item_id)
    `,
  ],
};
