import {
  HarnessConnectionService,
  type HarnessConnectionPolicy,
} from "../../harness/HarnessConnectionService";
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

export function createPostgresProviderConfigService(
  env: Env,
  userId: string,
  workspaceId: string,
  scopeKey?: string,
): ProviderConfigService {
  const databaseConfig = readBrainDatabaseConfig(env);
  const sqlClient = createPostgresSqlClient(
    databaseConfig.connectionString,
    scopeKey,
  );
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
    ensureReady: () => runAutomaticMigrations(databaseConfig, sqlClient),
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

/** P13 supplies existing authenticated workspace/admission/fencing policy. */
export function createPostgresHarnessConnectionService(
  env: Env,
  userId: string,
  workspaceId: string,
  policy: Omit<HarnessConnectionPolicy, "ensureReady">,
): HarnessConnectionService {
  const databaseConfig = readBrainDatabaseConfig(env);
  const client = createPostgresSqlClient(databaseConfig.connectionString);
  const encryption = getProviderEncryptionConfig(
    env as unknown as Record<string, unknown>,
  );
  const store = new PostgresCredentialStore(
    client,
    userId,
    workspaceId,
    encryption.masterKey,
    encryption.keyVersion,
    encryption.previousMasterKey,
  );
  return new HarnessConnectionService(
    store,
    {
      ...policy,
      ensureReady: () => runAutomaticMigrations(databaseConfig, client),
    },
    {
      async deliver(binding, expected, project) {
        const result = await client.transaction(async (tx) => {
          // The canonical owner locks turn/session/workspace/admission first.
          // All nested repository transactions are savepoints on THIS client.
          await policy.authorizeAttempt(binding, tx);
          const locked = await tx.query(
            "SELECT id FROM provider_credentials WHERE user_id=$1 AND id=$2 AND provider_id=$3 FOR UPDATE",
            [userId, expected.connectionId, expected.providerId],
          );
          if (!locked.rows[0]) return null;
          const acquired = await new PostgresCredentialStore(
            tx,
            userId,
            workspaceId,
            encryption.masterKey,
            encryption.keyVersion,
            encryption.previousMasterKey,
          ).acquireConnection(expected);
          if (!acquired) return null;
          await policy.assertRouteAllowed(
            binding,
            acquired.record.providerId,
            acquired.record.credentialKind,
          );
          policy.signal?.throwIfAborted();
          // The row lock fences revoke/refresh throughout AES decryption and
          // projection. Return plain access-only data, never this tx/store.
          return project(acquired.record, acquired.secret);
        });
        // Commit is the linearization point. A later revocation fences the
        // pinned process owner; cancellation can still suppress local delivery.
        policy.signal?.throwIfAborted();
        return result;
      },
    },
  );
}
