import { z } from "zod";
import { ProviderIdSchema } from "@repo/shared-types";
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

/** Pre-selection setup only. This is metadata, not admission or key delivery. */
export interface HarnessConnectionMetadataAuthority {
  authorizeMetadataScopeWithin(
    transaction: SqlClient,
    input: {
      readonly scope: Readonly<
        import("@repo/persistence").HarnessControlPlaneScope
      >;
      readonly expectedEnvironmentId: string;
    },
  ): Promise<void>;
}

export const HarnessConnectionMetadataRequestSchema = z
  .object({
    scope: z
      .object({
        userId: z.string().min(1).max(256),
        workspaceId: z.string().min(1).max(256),
        environmentId: z.string().min(1).max(256),
      })
      .strict()
      .readonly(),
    connectionId: z.string().min(1).max(256),
  })
  .strict()
  .readonly();
export type HarnessConnectionMetadataRequest = z.infer<
  typeof HarnessConnectionMetadataRequestSchema
>;

export const HarnessConnectionMetadataSchema = z
  .object({
    connectionId: z.string().min(1).max(256),
    providerId: ProviderIdSchema,
    credentialKind: z.enum(["api_key", "oauth", "external_reference"]),
    ownerGeneration: z.number().int().safe().positive(),
    tokenMaterialVersion: z.number().int().safe().positive(),
  })
  .strict()
  .readonly();
export type HarnessConnectionMetadata = z.infer<
  typeof HarnessConnectionMetadataSchema
>;

export interface HarnessConnectionMetadataReader {
  readConnectionMetadataWithin(
    transaction: SqlClient,
    connectionId: string,
  ): Promise<HarnessConnectionMetadata | null>;
}

export class HarnessConnectionMetadataService {
  constructor(
    private readonly authority: HarnessConnectionMetadataAuthority,
    private readonly custody: HarnessConnectionMetadataReader,
    private readonly userId: string,
    private readonly workspaceId: string,
    private readonly expectedEnvironmentId: string,
  ) {}

  async assertUsableConnectionWithin(
    transaction: SqlClient,
    input: HarnessConnectionMetadataRequest,
  ): Promise<HarnessConnectionMetadata | null> {
    const request = HarnessConnectionMetadataRequestSchema.parse(input);
    if (
      request.scope.userId !== this.userId ||
      request.scope.workspaceId !== this.workspaceId ||
      request.scope.environmentId !== this.expectedEnvironmentId
    )
      throw unavailable();
    await this.authority.authorizeMetadataScopeWithin(transaction, {
      scope: request.scope,
      expectedEnvironmentId: this.expectedEnvironmentId,
    });
    const value = await this.custody.readConnectionMetadataWithin(
      transaction,
      request.connectionId,
    );
    if (value === null) return null;
    const metadata = HarnessConnectionMetadataSchema.parse(value);
    if (metadata.connectionId !== request.connectionId) throw unavailable();
    // Non-locking observation only. Canonical setup must lock instance then
    // credential and recheck status and this exact generation/material tuple.
    return metadata;
  }
}
