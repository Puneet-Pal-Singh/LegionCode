import type {
  PostgresHarnessControlPlaneRepository,
  SqlClient,
} from "@repo/persistence";
import {
  LockedSelectedApiKeySchema,
  SelectedApiKeyProvenanceSchema,
  SelectedApiKeyRequestSchema,
  unavailable,
  type LockedSelectedApiKey,
  type SelectedApiKeyProvenance,
  type SelectedApiKeyRequest,
} from "./SelectedApiKeyProvenance";

export type HarnessSelectedAccountAuthority = Pick<
  PostgresHarnessControlPlaneRepository,
  "resolveAdmissionSelectionWithin"
>;
export interface HarnessSelectedKeyProjection {
  projectSelectedApiKey(
    transaction: SqlClient,
    selected: LockedSelectedApiKey,
  ): Promise<SelectedApiKeyProvenance>;
}

/** Called inside canonical admission's transaction, before custody. The P11
 * owner locks session/workspace/selection/instance/credential in that order.
 * Never re-enter admission authorization after the credential lock. */
export class HarnessConnectionService {
  constructor(
    private readonly authority: HarnessSelectedAccountAuthority,
    private readonly custody: HarnessSelectedKeyProjection,
    private readonly expectedEnvironmentId: string,
  ) {}

  async withSelectedApiKeyProvenance<T>(
    transaction: SqlClient,
    input: SelectedApiKeyRequest,
    commit: (
      transaction: SqlClient,
      provenance: SelectedApiKeyProvenance,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const request = SelectedApiKeyRequestSchema.parse(input);
    signal?.throwIfAborted();
    const resolved = await this.authority.resolveAdmissionSelectionWithin(
      transaction,
      {
        scope: {
          userId: request.scope.userId,
          workspaceId: request.scope.workspaceId,
          environmentId: request.scope.environmentId,
        },
        sessionId: request.scope.sessionId,
        threadId: request.scope.threadId,
        capture: request.capture,
        expectedEnvironmentId: this.expectedEnvironmentId,
      },
    );
    if (
      !resolved.selection ||
      !resolved.instance ||
      !resolved.credential ||
      resolved.credential.credentialKind !== "api_key" ||
      resolved.credential.providerId !== request.providerId ||
      resolved.revision !== request.capture.selectionRevision ||
      JSON.stringify(resolved.selection) !==
        JSON.stringify(request.capture.selection) ||
      resolved.scope.userId !== request.scope.userId ||
      resolved.scope.workspaceId !== request.scope.workspaceId ||
      resolved.scope.environmentId !== this.expectedEnvironmentId ||
      resolved.sessionId !== request.scope.sessionId ||
      resolved.threadId !== request.scope.threadId
    )
      throw unavailable();
    const selected = LockedSelectedApiKeySchema.parse({
      request,
      instanceAuthOwnerGeneration: resolved.instance.authOwnerGeneration,
      credential: {
        userId: resolved.scope.userId,
        providerId: resolved.credential.providerId,
        connectionId: resolved.credential.connectionId,
        ownerGeneration: resolved.credential.authOwnerGeneration,
        tokenMaterialVersion: resolved.credential.tokenMaterialVersion,
      },
    });
    if (
      selected.instanceAuthOwnerGeneration !==
      selected.credential.ownerGeneration
    )
      throw unavailable();
    signal?.throwIfAborted();
    const provenance = SelectedApiKeyProvenanceSchema.parse(
      await this.custody.projectSelectedApiKey(transaction, selected),
    );
    if (
      JSON.stringify(provenance.request) !== JSON.stringify(request) ||
      JSON.stringify(provenance.credential) !==
        JSON.stringify(selected.credential) ||
      provenance.instanceAuthOwnerGeneration !==
        selected.instanceAuthOwnerGeneration
    )
      throw unavailable();
    signal?.throwIfAborted();
    // Commit metadata on this same transaction. No new authorization/lock cycle.
    return commit(transaction, provenance);
  }
}
