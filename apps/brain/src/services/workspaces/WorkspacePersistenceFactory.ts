import {
  DatabaseConfigurationError,
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  PostgresWorkspaceRepository,
  readWorkerDatabaseConfig,
  withPostgresSqlClient,
  type DatabaseMigrationsMode,
  type SqlClient,
  type WorkerDatabaseConfig,
  type WorkspaceRepository,
} from "@repo/persistence";
import { DependencyError } from "../../domain/errors";
import type { Env } from "../../types/ai";

export async function withWorkspaceRepository<T>(
  env: Env,
  callback: (repository: WorkspaceRepository) => Promise<T>,
): Promise<T> {
  if (env.AUTH_WORKSPACE_REPOSITORY) {
    return await callback(env.AUTH_WORKSPACE_REPOSITORY);
  }

  const databaseConfig = readBrainDatabaseConfig(env);
  return await withPostgresSqlClient(
    databaseConfig.connectionString,
    async (client) => {
      await runAutomaticMigrations(databaseConfig.migrationsMode, client);
      return await callback(new PostgresWorkspaceRepository(client));
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

    throw error;
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
