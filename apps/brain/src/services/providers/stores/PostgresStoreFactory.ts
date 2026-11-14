import {
  DatabaseConfigurationError,
  persistenceMigrations,
  PostgresMigrationLedger,
  PostgresMigrationRunner,
  createPostgresSqlClient,
  readWorkerDatabaseConfig,
  type SqlClient,
  type WorkerDatabaseConfig,
  NativeProviderBindingScopeSchema,
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
import {
  NativeProviderCredentialResolver,
  type NativeProviderCredentialContext,
} from "../NativeProviderCredentialResolver";

export function createPostgresProviderConfigService(
  env: Env,
  userId: string,
  workspaceId: string,
  scopeKey?: string,
  nativeContext?: NativeProviderCredentialContext,
): ProviderConfigService {
  if (nativeContext) {
    const scope = NativeProviderBindingScopeSchema.parse(nativeContext.scope);
    if (scope.userId !== userId || scope.workspaceId !== workspaceId || scope.runId !== scopeKey) {
      throw new Error("Native credential context does not match its provider store scope");
    }
  }
  const databaseConfig = readBrainDatabaseConfig(env);
  const sqlClient = createPostgresSqlClient(
    databaseConfig.connectionString,
    scopeKey,
  );
  const encryptionConfig = getProviderEncryptionConfig(
    env as unknown as Record<string, unknown>,
  );
  const credentialStore = new PostgresCredentialStore(
    sqlClient,
    userId,
    workspaceId,
    encryptionConfig.masterKey,
    encryptionConfig.keyVersion,
    encryptionConfig.previousMasterKey,
  );

  return new ProviderConfigService({
    env,
    userId,
    workspaceId,
    credentialStore,
    ...(nativeContext ? { nativeCredentialResolver: new NativeProviderCredentialResolver({
      context: nativeContext, credentials: credentialStore, env,
    }) } : {}),
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

  await runPendingMigrations(client);
}

async function runPendingMigrations(client: SqlClient): Promise<void> {
  const runner = new PostgresMigrationRunner(
    client,
    new PostgresMigrationLedger(),
  );
  await runner.runPending(persistenceMigrations);
}
