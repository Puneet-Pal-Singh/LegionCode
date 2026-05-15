import {
  DatabaseConfigurationError,
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  createPostgresSqlClient,
  readWorkerDatabaseConfig,
  type DatabaseMigrationsMode,
  type SqlClient,
  type WorkerDatabaseConfig,
} from "@repo/persistence";
import { ProviderConfigService } from "../ProviderConfigService";
import {
  PostgresCredentialStore,
  PostgresPreferenceStore,
  PostgresProviderAuditLog,
  PostgresProviderModelCacheStore,
  PostgresProviderQuotaStore,
} from "@repo/persistence";
import { DependencyError } from "../../../domain/errors";
import type { Env } from "../../../types/ai";
import { getProviderEncryptionConfig } from "./ProviderEncryptionConfig";

let autoMigrationRun: Promise<void> | null = null;

export function createPostgresProviderConfigService(
  env: Env,
  userId: string,
  workspaceId: string,
): ProviderConfigService {
  const databaseConfig = readBrainDatabaseConfig(env);
  const sqlClient = createPostgresSqlClient(databaseConfig.connectionString);
  const encryptionConfig = getProviderEncryptionConfig(
    env as unknown as Record<string, unknown>,
  );

  return new ProviderConfigService({
    env,
    userId,
    workspaceId,
    credentialStore: new PostgresCredentialStore(
      sqlClient,
      userId,
      workspaceId,
      encryptionConfig.masterKey,
      encryptionConfig.keyVersion,
      encryptionConfig.previousKeyVersion,
    ),
    preferenceStore: new PostgresPreferenceStore(
      sqlClient,
      userId,
      workspaceId,
    ),
    modelCacheStore: new PostgresProviderModelCacheStore(sqlClient, userId),
    auditLog: new PostgresProviderAuditLog(sqlClient, userId, workspaceId),
    quotaStore: new PostgresProviderQuotaStore(sqlClient, userId, workspaceId),
    ensureReady: () =>
      runAutomaticMigrations(databaseConfig.migrationsMode, sqlClient),
  });
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
