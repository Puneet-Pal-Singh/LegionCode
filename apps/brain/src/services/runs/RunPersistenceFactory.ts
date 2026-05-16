import {
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  PostgresRunRepository,
  readWorkerDatabaseConfig,
  withPostgresSqlClient,
  type DatabaseMigrationsMode,
  type RunRepository,
  type SqlClient,
  type WorkerDatabaseConfig,
} from "@repo/persistence";
import { DependencyError } from "../../domain/errors";
import type { Env } from "../../types/ai";

export async function withRunRepository<T>(
  env: Env,
  callback: (repository: RunRepository) => Promise<T>,
): Promise<T> {
  const databaseConfig = readBrainDatabaseConfig(env);

  return withPostgresSqlClient(
    databaseConfig.connectionString,
    async (client) => {
      await runAutomaticMigrations(databaseConfig.migrationsMode, client);
      const repository = new PostgresRunRepository(client);
      return callback(repository);
    },
  );
}

function readBrainDatabaseConfig(env: Env): WorkerDatabaseConfig {
  try {
    return readWorkerDatabaseConfig(env);
  } catch (error) {
    throw new DependencyError(
      error instanceof Error ? error.message : "Database configuration error",
      "DATABASE_CONFIG_ERROR",
      false,
    );
  }
}

async function runAutomaticMigrations(
  migrationsMode: DatabaseMigrationsMode,
  client: SqlClient,
): Promise<void> {
  if (migrationsMode !== "auto") {
    return;
  }

  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}
