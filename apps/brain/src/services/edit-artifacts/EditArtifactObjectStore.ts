import {
  EditArtifactPatchObjectMetadataSchema,
  type EditArtifactPatchObjectMetadata,
} from "@repo/shared-types";
import type { R2Bucket } from "@cloudflare/workers-types";

const EDIT_ARTIFACT_KEY_PREFIX = "edit-artifacts/";

export interface StoredEditArtifactPatch {
  key: string;
  etag: string;
  size: number;
  metadata: EditArtifactPatchObjectMetadata;
}

export class EditArtifactObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

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
    const metadata = EditArtifactPatchObjectMetadataSchema.parse(
      input.metadata,
    );
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
