import type { SqlMigration } from "./types.js";
import { buildRunStatusSqlList } from "../runs/types.js";
import { buildSessionStatusSqlList } from "../sessions/types.js";

const RUN_STATUS_SQL_LIST = buildRunStatusSqlList();
const SESSION_STATUS_SQL_LIST = buildSessionStatusSqlList();

export const pausedRunAndSessionStatusMigration: SqlMigration = {
  id: "0014_paused_run_and_session_status",
  description: "Allow paused run and session status values",
  statements: [
    `
      ALTER TABLE runs
        DROP CONSTRAINT IF EXISTS runs_status_check
    `,
    `
      ALTER TABLE runs
        ADD CONSTRAINT runs_status_check
          CHECK (status IN (${RUN_STATUS_SQL_LIST}))
    `,
    `
      ALTER TABLE sessions
        DROP CONSTRAINT IF EXISTS sessions_status_check
    `,
    `
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_status_check
          CHECK (status IN (${SESSION_STATUS_SQL_LIST}))
    `,
  ],
};
