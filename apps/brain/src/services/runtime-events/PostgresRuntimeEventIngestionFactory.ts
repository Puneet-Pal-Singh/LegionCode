import {
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  PostgresRuntimeEventInboxRepository,
  withPostgresSqlClient,
  type SqlClient,
} from "@repo/persistence";
import { DependencyError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { RuntimeEventIngestionService } from "./RuntimeEventIngestionService";
import { createRuntimeEventIngestionService } from "./factory";

export async function withPostgresRuntimeEventIngestionService<T>(
  env: Env,
  callback: (service: RuntimeEventIngestionService) => Promise<T>,
): Promise<T> {
  const connectionString = readHyperdriveConnectionString(env);

  return withPostgresSqlClient(connectionString, async (client) => {
    await runAutomaticMigrations(env, client);
    const repository = new PostgresRuntimeEventInboxRepository(client);
    const service = createRuntimeEventIngestionService(env, repository);
    return callback(service);
  });
}

function readHyperdriveConnectionString(env: Env): string {
  const connectionString = env.HYPERDRIVE?.connectionString?.trim();
  if (!connectionString) {
    throw new DependencyError(
      "HYPERDRIVE binding is required for runtime event ingestion",
      "HYPERDRIVE_BINDING_MISSING",
      false,
    );
  }
  return connectionString;
}

async function runAutomaticMigrations(
  env: Env,
  client: SqlClient,
): Promise<void> {
  if (env.DATABASE_MIGRATIONS_MODE !== "auto") {
    return;
  }

  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}
