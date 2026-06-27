import {
  buildRunStatusSqlList,
  buildRunStepStatusSqlList,
} from "../runs/types.js";
import type { SqlMigration } from "./types.js";

const RUN_STATUS_SQL_LIST = buildRunStatusSqlList();
const RUN_STEP_STATUS_SQL_LIST = buildRunStepStatusSqlList();

export const runBootstrapMigration: SqlMigration = {
  id: "0006_run_bootstrap",
  description: "Create canonical run, run step, and run event tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'created',
        mode TEXT NOT NULL DEFAULT 'build',
        provider_id TEXT,
        model_id TEXT,
        branch TEXT,
        base_commit_sha TEXT,
        head_commit_sha TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT runs_status_check
          CHECK (status IN (${RUN_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS runs_user_idx
        ON runs (user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS runs_session_idx
        ON runs (session_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS runs_task_idx
        ON runs (task_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS runs_workspace_idx
        ON runs (workspace_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS run_steps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        payload_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT run_steps_status_check
          CHECK (status IN (${RUN_STEP_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS run_steps_run_index_idx
        ON run_steps (run_id, step_index)
    `,
    `
      CREATE TABLE IF NOT EXISTS run_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}',
        sequence BIGINT NOT NULL,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT run_events_run_sequence_idx
          UNIQUE (run_id, sequence),
        CONSTRAINT run_events_run_idempotency_idx
          UNIQUE (run_id, idempotency_key)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS run_events_session_idx
        ON run_events (session_id)
    `,
  ],
};
