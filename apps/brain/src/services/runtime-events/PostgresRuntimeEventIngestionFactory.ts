import {
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  PostgresRuntimeEventInboxRepository,
  DatabaseConfigurationError,
  readWorkerDatabaseConfig,
  withPostgresSqlClient,
  type DatabaseMigrationsMode,
  type SqlClient,
  type WorkerDatabaseConfig,
} from "@repo/persistence";
import { DependencyError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { RuntimeEventIngestionService } from "./RuntimeEventIngestionService";
import { createRuntimeEventIngestionService } from "./factory";

export async function withPostgresRuntimeEventIngestionService<T>(
  env: Env,
  callback: (service: RuntimeEventIngestionService) => Promise<T>,
): Promise<T> {
  const databaseConfig = readBrainDatabaseConfig(env);

  return withPostgresSqlClient(
    databaseConfig.connectionString,
    async (client) => {
      await runAutomaticMigrations(databaseConfig.migrationsMode, client);
      const repository = new PostgresRuntimeEventInboxRepository(client);
      const service = createRuntimeEventIngestionService(env, repository);
      return callback(service);
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
