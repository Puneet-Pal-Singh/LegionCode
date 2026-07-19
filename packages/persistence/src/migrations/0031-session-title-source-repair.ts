import type { SqlMigration } from "./types.js";

/**
 * Repairs databases where the title-source constraint was recorded before
 * preview titles were introduced. This is intentionally idempotent because
 * existing environments may already have the earlier migration in their
 * ledger while retaining its old constraint definition.
 */
export const sessionTitleSourceRepairMigration: SqlMigration = {
  id: "0031_session_title_source_repair",
  description: "Allow preview, generated, and user session title sources",
  statements: [
    `ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_title_source_check`,
    `ALTER TABLE sessions ADD CONSTRAINT sessions_title_source_check CHECK (title_source IN ('preview', 'generated', 'user'))`,
  ],
};
