import type { SqlMigration } from "./types.js";

/** The old projectless UI label was persisted as if it were a repository. */
export const projectlessSessionRepositoryMigration: SqlMigration = {
  id: "0034_projectless_session_repository",
  description: "Normalize projectless session repository labels to null",
  statements: [
    `UPDATE sessions SET repository = NULL WHERE repository = 'New Project'`,
  ],
};
