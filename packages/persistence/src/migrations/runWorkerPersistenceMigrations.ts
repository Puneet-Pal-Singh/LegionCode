import {
  readWorkerDatabaseConfig,
  type WorkerDatabaseEnv,
} from "../config/database.js";
import { withPostgresSqlClient } from "../postgres/PgSqlClient.js";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { PostgresMigrationLedger } from "./PostgresMigrationLedger.js";
import { PostgresMigrationRunner } from "./PostgresMigrationRunner.js";
import type { MigrationRunResult } from "./types.js";

/**
 * Explicit operator boundary for Worker-hosted Postgres migrations.
 *
 * Production request handlers keep DATABASE_MIGRATIONS_MODE=manual. This
 * function is called only by the scheduled-only migration worker, so schema
 * changes never become a public HTTP capability or an incidental request-path
 * side effect.
 */
export async function runWorkerPersistenceMigrations(
  env: WorkerDatabaseEnv,
): Promise<MigrationRunResult> {
  const { connectionString } = readWorkerDatabaseConfig(env);
  return await withPostgresSqlClient(connectionString, async (client) => {
    const runner = new PostgresMigrationRunner(
      client,
      new PostgresMigrationLedger(),
    );
    return await runner.runPending(persistenceMigrations);
  });
}
