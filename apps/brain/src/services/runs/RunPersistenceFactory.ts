import {
  DatabaseConfigurationError,
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

let autoMigrationRun: Promise<void> | null = null;

export async function withRunRepository<T>(
  env: Env,
  callback: (repository: RunRepository) => Promise<T>,
): Promise<T> {
  if (env.AUTH_RUN_REPOSITORY) {
    return await callback(env.AUTH_RUN_REPOSITORY);
  }

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

  autoMigrationRun ??= runPendingMigrations(client).catch((error: unknown) => {
    autoMigrationRun = null;
    throw error;
  });
  await autoMigrationRun;
}

async function runPendingMigrations(client: SqlClient): Promise<void> {
  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}
