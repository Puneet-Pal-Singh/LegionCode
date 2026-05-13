import type { SqlClient } from "../sql.js";

export interface SqlMigration {
  id: string;
  description: string;
  statements: readonly string[];
}

export interface MigrationRunResult {
  applied: readonly string[];
  skipped: readonly string[];
}

export interface MigrationRunner {
  runPending(migrations: readonly SqlMigration[]): Promise<MigrationRunResult>;
}

export interface MigrationLedger {
  ensureReady(client: SqlClient): Promise<void>;
  hasMigration(client: SqlClient, migrationId: string): Promise<boolean>;
  recordMigration(client: SqlClient, migration: SqlMigration): Promise<void>;
}
