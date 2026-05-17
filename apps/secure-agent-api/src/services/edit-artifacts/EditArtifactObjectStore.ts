import {
  EditArtifactPatchObjectMetadataSchema,
  type EditArtifactPatchObjectMetadata,
} from "@repo/shared-types";

const EDIT_ARTIFACT_KEY_PREFIX = "edit-artifacts/";

interface R2ObjectCompat {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
  text(): Promise<string>;
}

interface R2BucketCompat {
  head(key: string): Promise<R2ObjectCompat | null>;
  get(key: string): Promise<R2ObjectCompat | null>;
  put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<R2ObjectCompat>;
  delete(key: string): Promise<void>;
}

export interface StoredEditArtifactPatch {
  key: string;
  etag: string;
  size: number;
  metadata: EditArtifactPatchObjectMetadata;
}

export class EditArtifactObjectStore {
  constructor(private readonly bucket: R2BucketCompat) {}

  buildPatchKey(input: {
    userId: string;
    workspaceId: string;
    runId: string;
    artifactId: string;
  }): string {
    return [
      "edit-artifacts",
      encodePathSegment(input.userId),
      encodePathSegment(input.workspaceId),
      encodePathSegment(input.runId),
      encodePathSegment(input.artifactId),
      "diff.patch",
    ].join("/");
  }

  async writePatch(input: {
    key: string;
    patch: string;
    metadata: EditArtifactPatchObjectMetadata;
  }): Promise<StoredEditArtifactPatch> {
    assertPatchKeyScope(input.key);
    const metadata = EditArtifactPatchObjectMetadataSchema.parse(input.metadata);
    const object = await this.bucket.put(input.key, input.patch, {
      customMetadata: serializeMetadata(metadata),
    });

    return {
      key: object.key,
      etag: object.etag,
      size: object.size,
      metadata,
    };
  }

  async readPatch(key: string): Promise<string | null> {
    assertPatchKeyScope(key);
    const object = await this.bucket.get(key);
    return object ? await object.text() : null;
  }

  async getPatchMetadata(
    key: string,
  ): Promise<StoredEditArtifactPatch | null> {
    assertPatchKeyScope(key);
    const object = await this.bucket.head(key);
    if (!object?.customMetadata) {
      return null;
    }

    return {
      key: object.key,
      etag: object.etag,
      size: object.size,
      metadata: deserializeMetadata(object.customMetadata),
    };
  }

  async deletePatch(key: string): Promise<void> {
    assertPatchKeyScope(key);
    await this.bucket.delete(key);
  }
}

function assertPatchKeyScope(key: string): void {
  if (!isCanonicalPatchKey(key)) {
    throw new Error("Invalid edit artifact key scope");
  }
}

function isCanonicalPatchKey(key: string): boolean {
  const segments = key.split("/");
  return (
    key.startsWith(EDIT_ARTIFACT_KEY_PREFIX) &&
    segments.length === 6 &&
    segments[5] === "diff.patch" &&
    segments.slice(1, 5).every((segment) => segment.trim().length > 0)
  );
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function serializeMetadata(
  metadata: EditArtifactPatchObjectMetadata,
): Record<string, string> {
  return {
    schemaVersion: String(metadata.schemaVersion),
    artifactId: metadata.artifactId,
    userId: metadata.userId,
    runId: metadata.runId,
    sessionId: metadata.sessionId,
    workspaceId: metadata.workspaceId,
    repoOwner: metadata.repoOwner ?? "",
    repoName: metadata.repoName ?? "",
    branch: metadata.branch ?? "",
    baseCommitSha: metadata.baseCommitSha ?? "",
    patchSha256: metadata.patchSha256,
    changedFilesJson: JSON.stringify(metadata.changedFiles),
    capturedAt: metadata.capturedAt,
  };
}

function deserializeMetadata(
  customMetadata: Record<string, string>,
): EditArtifactPatchObjectMetadata {
  return EditArtifactPatchObjectMetadataSchema.parse({
    schemaVersion: Number(customMetadata.schemaVersion),
    artifactId: customMetadata.artifactId,
    userId: customMetadata.userId,
    runId: customMetadata.runId,
    sessionId: customMetadata.sessionId,
    workspaceId: customMetadata.workspaceId,
    repoOwner: emptyToNull(customMetadata.repoOwner),
    repoName: emptyToNull(customMetadata.repoName),
    branch: emptyToNull(customMetadata.branch),
    baseCommitSha: emptyToNull(customMetadata.baseCommitSha),
    patchSha256: customMetadata.patchSha256,
    changedFiles: JSON.parse(customMetadata.changedFilesJson ?? "[]") as unknown,
    capturedAt: customMetadata.capturedAt,
  });
}

function emptyToNull(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}
