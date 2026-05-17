import {
  DatabaseConfigurationError,
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  readWorkerDatabaseConfig,
  withPostgresSqlClient,
  type DatabaseMigrationsMode,
  type SqlClient,
  type WorkerDatabaseConfig,
} from "@repo/persistence";
import { DependencyError } from "../../domain/errors";
import type { Env } from "../../types/ai";

const autoMigrationRuns = new Map<string, Promise<void>>();

export async function withBrainPersistenceRepository<T, Repository>(
  env: Env,
  overrideRepository: Repository | undefined,
  createRepository: (client: SqlClient) => Repository,
  callback: (repository: Repository) => Promise<T>,
): Promise<T> {
  if (overrideRepository) {
    return await callback(overrideRepository);
  }

  const databaseConfig = readBrainDatabaseConfig(env);

  return await withPostgresSqlClient(
    databaseConfig.connectionString,
    async (client) => {
      await runAutomaticMigrations(
        databaseConfig.connectionString,
        databaseConfig.migrationsMode,
        client,
      );
      return await callback(createRepository(client));
    },
  );
}

function readBrainDatabaseConfig(env: Env): WorkerDatabaseConfig {
  try {
    return readWorkerDatabaseConfig(env);
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) {
      throw new DependencyError(error.message, error.code, false);
    }

    throw new DependencyError(
      error instanceof Error ? error.message : "Database configuration error",
      "DATABASE_CONFIG_ERROR",
      false,
    );
  }
}

async function runAutomaticMigrations(
  connectionString: string,
  migrationsMode: DatabaseMigrationsMode,
  client: SqlClient,
): Promise<void> {
  if (migrationsMode !== "auto") {
    return;
  }

  const inFlight =
    autoMigrationRuns.get(connectionString) ??
    runPendingMigrations(client).catch((error: unknown) => {
      autoMigrationRuns.delete(connectionString);
      throw error;
    });
  autoMigrationRuns.set(connectionString, inFlight);
  await inFlight;
}

async function runPendingMigrations(client: SqlClient): Promise<void> {
  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}
