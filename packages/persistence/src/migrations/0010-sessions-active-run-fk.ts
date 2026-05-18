import type { SqlMigration } from "./types.js";

export const sessionsActiveRunForeignKeyMigration: SqlMigration = {
  id: "0010_sessions_active_run_fk",
  description: "Add and validate sessions active run foreign key",
  statements: [
    `
      ALTER TABLE sessions
        ADD CONSTRAINT sessions_active_run_id_fk
        FOREIGN KEY (active_run_id) REFERENCES runs(id)
        ON DELETE SET NULL
        NOT VALID
    `,
    `
      ALTER TABLE sessions
        VALIDATE CONSTRAINT sessions_active_run_id_fk
    `,
  ],
};
