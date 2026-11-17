import { AppServerOperationError } from "@legioncode/app-server/server";
import {
  HarnessControlPlaneConflictError, PostgresHarnessControlPlaneRepository,
  type SqlClient, type StoredHarnessInstance,
} from "@repo/persistence";
import type { HarnessSetupRequest } from "@repo/platform-protocol";
import type { HostedHarnessOperationContext } from "../../integration/app-server/HostedHarnessOperations";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import { createPostgresHarnessConnectionMetadataService } from "../providers/stores/PostgresStoreFactory";
import type { HarnessConnectionMetadata } from "./HarnessConnectionService";

export interface HostedHarnessMetadataTransaction {
  readonly repository: PostgresHarnessControlPlaneRepository;
  setup(params: HarnessSetupRequest): Promise<StoredHarnessInstance>;
  connection(connectionId: string): Promise<HarnessConnectionMetadata | null>;
}
export interface HostedHarnessControlPlane {
  within<T>(context: HostedHarnessOperationContext, operation: (ports: HostedHarnessMetadataTransaction) => Promise<T>): Promise<T>;
}

/** Each operation leases one client and one transaction. Repository transactions
 * use savepoints on that same pinned client; no repository or custody reader
 * escapes the lease callback. No credential SQL or decryption lives here. */
export function createPostgresHostedHarnessControlPlane(
  env: Env,
  expectedEnvironmentId: string | null,
): HostedHarnessControlPlane {
  return {
    async within(context, operation) {
      const scope = Object.freeze({ userId: context.userId, workspaceId: context.workspaceId, environmentId: context.environmentId });
      if (expectedEnvironmentId === null)
        throw new AppServerOperationError(503, "server_unavailable", "Hosted harness placement is unavailable");
      if (scope.environmentId !== expectedEnvironmentId)
        throw new AppServerOperationError(403, "unauthorized", "Hosted harness placement does not match");
      context.signal.throwIfAborted();
      try {
        return await withBrainPersistenceRepository(env, undefined, (client) => client, (client) =>
          client.transaction(async (tx: SqlClient) => {
            const repository = new PostgresHarnessControlPlaneRepository(tx);
            await repository.authorizeMetadataScopeWithin(tx, { scope, expectedEnvironmentId });
            let connections: ReturnType<typeof createPostgresHarnessConnectionMetadataService> | undefined;
            const connection = async (connectionTx: SqlClient, connectionId: string) => {
              context.signal.throwIfAborted();
              // Exact setup receipts do not depend on current encryption config
              // or metadata. The canonical repository invokes this only for NEW commands.
              connections ??= createPostgresHarnessConnectionMetadataService(
                env, scope.userId, scope.workspaceId, repository, expectedEnvironmentId,
              );
              const metadata = await connections.assertUsableConnectionWithin(connectionTx, { scope, connectionId });
              context.signal.throwIfAborted();
              return metadata;
            };
            context.signal.throwIfAborted();
            const result = await operation({ repository,
              setup: (params) => repository.setupInstance(scope, params, expectedEnvironmentId, connection),
              connection: (connectionId) => connection(tx, connectionId),
            });
            context.signal.throwIfAborted();
            return result;
          }),
        );
      } catch (error) {
        if (error instanceof AppServerOperationError) throw error;
        if (error instanceof HarnessControlPlaneConflictError) {
          if (error.code === "not_found") throw new AppServerOperationError(404, "not_found", "Owned harness configuration was not found");
          if (error.code === "connection_unavailable") throw new AppServerOperationError(503, "server_unavailable", "Selected harness connection is unavailable");
          throw new AppServerOperationError(409, "invalid_request", "Harness command conflicts with canonical configuration");
        }
        throw new AppServerOperationError(503, "server_unavailable", "Hosted harness metadata is unavailable");
      }
    },
  };
}
