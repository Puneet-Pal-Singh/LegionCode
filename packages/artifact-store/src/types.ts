import {
  ArtifactIdSchema,
  JsonRecordSchema,
  ProtocolTimestampSchema,
  RunIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type ArtifactId,
} from "@repo/platform-protocol";
import { z } from "zod";

export const ArtifactKindSchema = z.enum([
  "diff",
  "patch",
  "command_log",
  "screenshot",
  "generated_file",
  "context_checkpoint",
  "workspace_snapshot",
  "final_report",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactVisibilitySchema = z.enum([
  "private",
  "run",
  "thread",
  "workspace",
]);
export type ArtifactVisibility = z.infer<typeof ArtifactVisibilitySchema>;

export const ArtifactPayloadBackendSchema = z.enum([
  "r2",
  "local_blob",
  "memory",
]);
export type ArtifactPayloadBackend = z.infer<
  typeof ArtifactPayloadBackendSchema
>;

export const ArtifactSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export type ArtifactSha256 = z.infer<typeof ArtifactSha256Schema>;

export const ArtifactOwnershipSchema = z
  .object({
    createdBy: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
  })
  .strict();
export type ArtifactOwnership = z.infer<typeof ArtifactOwnershipSchema>;

export const ArtifactPayloadReferenceSchema = z
  .object({
    backend: ArtifactPayloadBackendSchema,
    storageKey: z.string().min(1).max(1_024),
    contentType: z.string().min(1).max(255),
    byteSize: z.number().int().safe().nonnegative(),
    sha256: ArtifactSha256Schema,
  })
  .strict();
export type ArtifactPayloadReference = z.infer<
  typeof ArtifactPayloadReferenceSchema
>;

export const ArtifactMetadataSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    kind: ArtifactKindSchema,
    ownership: ArtifactOwnershipSchema,
    visibility: ArtifactVisibilitySchema,
    payload: ArtifactPayloadReferenceSchema,
    properties: JsonRecordSchema,
    createdAt: ProtocolTimestampSchema,
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export const ArtifactAccessContextSchema = z
  .object({
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema.nullable(),
    runId: RunIdSchema.nullable(),
  })
  .strict();
export type ArtifactAccessContext = z.infer<typeof ArtifactAccessContextSchema>;

export type ArtifactAccessOperation =
  | "create"
  | "read_metadata"
  | "read_payload"
  | "list"
  | "delete";

export interface ArtifactAuthorizationInput {
  readonly operation: ArtifactAccessOperation;
  readonly access: ArtifactAccessContext;
  readonly metadata: ArtifactMetadata | null;
}

export interface ArtifactAuthorizer {
  authorize(input: ArtifactAuthorizationInput): Promise<boolean>;
}

export interface PutArtifactInput {
  readonly artifactId?: ArtifactId;
  readonly idempotencyKey: string;
  readonly kind: ArtifactKind;
  readonly ownership: ArtifactOwnership;
  readonly visibility: ArtifactVisibility;
  readonly contentType: string;
  readonly payload: Uint8Array;
  readonly expectedSha256?: ArtifactSha256;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface ArtifactMetadataRepository {
  put(metadata: ArtifactMetadata, idempotencyKey: string): Promise<void>;
  get(artifactId: ArtifactId): Promise<ArtifactMetadata | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<ArtifactMetadata | null>;
  list(workspaceId: ArtifactOwnership["workspaceId"]): Promise<ArtifactMetadata[]>;
  delete(artifactId: ArtifactId): Promise<boolean>;
}

export interface ArtifactPayloadStore {
  put(reference: ArtifactPayloadReference, payload: Uint8Array): Promise<void>;
  get(reference: ArtifactPayloadReference): Promise<Uint8Array | null>;
  delete(reference: ArtifactPayloadReference): Promise<boolean>;
}

export interface ArtifactStore {
  put(input: PutArtifactInput, access: ArtifactAccessContext): Promise<ArtifactMetadata>;
  getMetadata(
    artifactId: ArtifactId,
    access: ArtifactAccessContext,
  ): Promise<ArtifactMetadata | null>;
  getPayload(
    artifactId: ArtifactId,
    access: ArtifactAccessContext,
  ): Promise<Uint8Array | null>;
  list(access: ArtifactAccessContext): Promise<ArtifactMetadata[]>;
  delete(artifactId: ArtifactId, access: ArtifactAccessContext): Promise<boolean>;
}
