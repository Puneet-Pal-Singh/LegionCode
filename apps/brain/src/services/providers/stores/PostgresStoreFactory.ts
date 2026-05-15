import {
  DatabaseConfigurationError,
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  createPostgresSqlClient,
  readWorkerDatabaseConfig,
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

const autoMigrationRuns = new Map<string, Promise<void>>();

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
      encryptionConfig.previousMasterKey,
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
      runAutomaticMigrations(databaseConfig, sqlClient),
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
  databaseConfig: WorkerDatabaseConfig,
  client: SqlClient,
): Promise<void> {
  if (databaseConfig.migrationsMode !== "auto") {
    return;
  }

  const key = databaseConfig.connectionString;
  const existing = autoMigrationRuns.get(key);
  if (existing) {
    await existing;
    return;
  }

  const migrationRun = runPendingMigrations(client).catch((error: unknown) => {
    autoMigrationRuns.delete(key);
    throw error;
  });
  autoMigrationRuns.set(key, migrationRun);
  await migrationRun;
}

async function runPendingMigrations(client: SqlClient): Promise<void> {
  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}
