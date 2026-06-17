import {
  ArtifactAccessContextSchema,
  ArtifactMetadataSchema,
  ArtifactOwnershipSchema,
  ArtifactSha256Schema,
  ArtifactVisibilitySchema,
  type ArtifactAccessContext,
  type ArtifactAuthorizer,
  type ArtifactMetadata,
  type ArtifactMetadataRepository,
  type ArtifactPayloadReference,
  type ArtifactPayloadStore,
  type ArtifactStore,
  type PutArtifactInput,
} from "./types.js";
import { ArtifactStoreError } from "./errors.js";
import { ArtifactIdSchema, type ArtifactId } from "@repo/platform-protocol";

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export interface InMemoryArtifactStoreOptions {
  readonly authorizer: ArtifactAuthorizer;
  readonly now?: () => string;
  readonly createArtifactId?: () => ArtifactId;
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly metadataRepository = new InMemoryArtifactMetadataRepository();
  readonly payloadStore = new InMemoryArtifactPayloadStore();
  private sequence = 0;

  constructor(private readonly options: InMemoryArtifactStoreOptions) {}

  async put(
    input: PutArtifactInput,
    access: ArtifactAccessContext,
  ): Promise<ArtifactMetadata> {
    const parsedAccess = ArtifactAccessContextSchema.parse(access);
    requireMatchingOwnership(parsedAccess, ArtifactOwnershipSchema.parse(input.ownership));
    const existing = await this.metadataRepository.getByIdempotencyKey(
      validateIdempotencyKey(input.idempotencyKey),
    );
    if (existing) {
      await this.requireAuthorized("create", parsedAccess, existing);
      await this.requireIdempotentPayload(existing, input.payload);
      return cloneMetadata(existing);
    }

    await this.requireAuthorized("create", parsedAccess, null);
    const metadata = await this.buildMetadata(input);
    await this.payloadStore.put(metadata.payload, input.payload);
    await this.metadataRepository.put(metadata, input.idempotencyKey);
    return cloneMetadata(metadata);
  }

  async getMetadata(
    artifactId: ArtifactId,
    access: ArtifactAccessContext,
  ): Promise<ArtifactMetadata | null> {
    const metadata = await this.metadataRepository.get(ArtifactIdSchema.parse(artifactId));
    if (!metadata) {
      return null;
    }
    await this.requireAuthorized("read_metadata", access, metadata);
    return cloneMetadata(metadata);
  }

  async getPayload(
    artifactId: ArtifactId,
    access: ArtifactAccessContext,
  ): Promise<Uint8Array | null> {
    const metadata = await this.metadataRepository.get(ArtifactIdSchema.parse(artifactId));
    if (!metadata) {
      return null;
    }
    await this.requireAuthorized("read_payload", access, metadata);
    const payload = await this.payloadStore.get(metadata.payload);
    if (!payload) {
      throw new ArtifactStoreError(
        "artifact_payload_not_found",
        `Artifact payload not found: ${artifactId}`,
      );
    }
    return payload;
  }

  async list(access: ArtifactAccessContext): Promise<ArtifactMetadata[]> {
    const parsedAccess = ArtifactAccessContextSchema.parse(access);
    await this.requireAuthorized("list", parsedAccess, null);
    const metadata = await this.metadataRepository.list(parsedAccess.workspaceId);
    const authorized: ArtifactMetadata[] = [];
    for (const artifact of metadata) {
      if (await this.options.authorizer.authorize({
        operation: "read_metadata",
        access: parsedAccess,
        metadata: artifact,
      })) {
        authorized.push(cloneMetadata(artifact));
      }
    }
    return authorized;
  }

  async delete(artifactId: ArtifactId, access: ArtifactAccessContext): Promise<boolean> {
    const parsedId = ArtifactIdSchema.parse(artifactId);
    const metadata = await this.metadataRepository.get(parsedId);
    if (!metadata) {
      return false;
    }
    await this.requireAuthorized("delete", access, metadata);
    await this.payloadStore.delete(metadata.payload);
    return await this.metadataRepository.delete(parsedId);
  }

  private async buildMetadata(input: PutArtifactInput): Promise<ArtifactMetadata> {
    const sha256 = await computeSha256(input.payload);
    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      throw new ArtifactStoreError(
        "artifact_checksum_mismatch",
        "Artifact payload checksum does not match expectedSha256",
      );
    }
    const artifactId = input.artifactId ?? this.createArtifactId();
    return ArtifactMetadataSchema.parse({
      artifactId,
      kind: input.kind,
      ownership: ArtifactOwnershipSchema.parse(input.ownership),
      visibility: ArtifactVisibilitySchema.parse(input.visibility),
      payload: {
        backend: "memory",
        storageKey: `artifacts/${artifactId}`,
        contentType: input.contentType,
        byteSize: input.payload.byteLength,
        sha256,
      },
      properties: input.properties ?? {},
      createdAt: this.options.now?.() ?? DEFAULT_TIMESTAMP,
    });
  }

  private createArtifactId(): ArtifactId {
    this.sequence += 1;
    return this.options.createArtifactId?.() ??
      ArtifactIdSchema.parse(`art_memory_${String(this.sequence).padStart(6, "0")}`);
  }

  private async requireAuthorized(
    operation: Parameters<ArtifactAuthorizer["authorize"]>[0]["operation"],
    access: ArtifactAccessContext,
    metadata: ArtifactMetadata | null,
  ): Promise<void> {
    const parsedAccess = ArtifactAccessContextSchema.parse(access);
    if (!await this.options.authorizer.authorize({ operation, access: parsedAccess, metadata })) {
      throw new ArtifactStoreError(
        "artifact_access_denied",
        `Artifact operation denied: ${operation}`,
      );
    }
  }

  private async requireIdempotentPayload(
    existing: ArtifactMetadata,
    payload: Uint8Array,
  ): Promise<void> {
    if (existing.payload.sha256 !== await computeSha256(payload)) {
      throw new ArtifactStoreError(
        "artifact_idempotency_conflict",
        "Idempotency key is already associated with a different payload",
      );
    }
  }
}

class InMemoryArtifactMetadataRepository implements ArtifactMetadataRepository {
  private readonly records = new Map<ArtifactId, ArtifactMetadata>();
  private readonly idempotency = new Map<string, ArtifactId>();

  async put(metadata: ArtifactMetadata, idempotencyKey: string): Promise<void> {
    this.records.set(metadata.artifactId, cloneMetadata(metadata));
    this.idempotency.set(idempotencyKey, metadata.artifactId);
  }

  async get(artifactId: ArtifactId): Promise<ArtifactMetadata | null> {
    const metadata = this.records.get(artifactId);
    return metadata ? cloneMetadata(metadata) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<ArtifactMetadata | null> {
    const artifactId = this.idempotency.get(idempotencyKey);
    return artifactId ? await this.get(artifactId) : null;
  }

  async list(workspaceId: ArtifactMetadata["ownership"]["workspaceId"]): Promise<ArtifactMetadata[]> {
    return [...this.records.values()]
      .filter((metadata) => metadata.ownership.workspaceId === workspaceId)
      .map(cloneMetadata);
  }

  async delete(artifactId: ArtifactId): Promise<boolean> {
    for (const [key, value] of this.idempotency) {
      if (value === artifactId) {
        this.idempotency.delete(key);
      }
    }
    return this.records.delete(artifactId);
  }
}

class InMemoryArtifactPayloadStore implements ArtifactPayloadStore {
  private readonly payloads = new Map<string, Uint8Array>();

  async put(reference: ArtifactPayloadReference, payload: Uint8Array): Promise<void> {
    this.payloads.set(reference.storageKey, payload.slice());
  }

  async get(reference: ArtifactPayloadReference): Promise<Uint8Array | null> {
    return this.payloads.get(reference.storageKey)?.slice() ?? null;
  }

  async delete(reference: ArtifactPayloadReference): Promise<boolean> {
    return this.payloads.delete(reference.storageKey);
  }
}

async function computeSha256(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(payload).buffer);
  return ArtifactSha256Schema.parse(
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function validateIdempotencyKey(value: string): string {
  if (value.length < 1 || value.length > 256) {
    throw new ArtifactStoreError(
      "invalid_artifact_input",
      "idempotencyKey must contain between 1 and 256 characters",
    );
  }
  return value;
}

function cloneMetadata(metadata: ArtifactMetadata): ArtifactMetadata {
  return ArtifactMetadataSchema.parse(structuredClone(metadata));
}

function requireMatchingOwnership(
  access: ArtifactAccessContext,
  ownership: PutArtifactInput["ownership"],
): void {
  const matches =
    access.userId === ownership.createdBy &&
    access.workspaceId === ownership.workspaceId &&
    access.threadId === ownership.threadId &&
    access.runId === ownership.runId;
  if (!matches) {
    throw new ArtifactStoreError(
      "artifact_access_denied",
      "Artifact ownership must match the caller access scope",
    );
  }
}
