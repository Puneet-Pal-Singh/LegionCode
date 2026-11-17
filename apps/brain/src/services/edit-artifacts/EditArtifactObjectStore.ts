import {
  EditArtifactPatchObjectMetadataSchema,
  type EditArtifactPatchObjectMetadata,
} from "@repo/shared-types";
import {
  ArtifactIdSchema,
  type ArtifactPayloadRef,
} from "@repo/platform-protocol";
import { sha256Hex } from "./EditArtifactStorageBackend";
import type { R2Bucket } from "@cloudflare/workers-types";

const EDIT_ARTIFACT_KEY_PREFIX = "edit-artifacts/";
const RUNTIME_TURN_KEY_PREFIX = `${EDIT_ARTIFACT_KEY_PREFIX}runtime-turn/v1/`;
const JSON_CONTENT_TYPE = "application/json";
export const MAX_RUNTIME_TURN_ARTIFACT_BYTES = 5_000_000;

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

  async writeRuntimeTurnArtifact(input: {
    userId: string;
    workspaceId: string;
    threadId: string;
    runId: string;
    turnId: string;
    runAttemptId: string;
    artifactId: string;
    role: "snapshot_start" | "snapshot_terminal" | "turn_diff";
    checkoutId: string;
    checkoutGeneration: string;
    scopeSha256: string;
    payload: string;
  }): Promise<ArtifactPayloadRef> {
    const { payload, ...scope } = input;
    if (payload.length > MAX_RUNTIME_TURN_ARTIFACT_BYTES) {
      throw new Error("Canonical artifact exceeds the size limit");
    }
    const bytes = new TextEncoder().encode(payload);
    if (bytes.byteLength > MAX_RUNTIME_TURN_ARTIFACT_BYTES) {
      throw new Error("Canonical artifact exceeds the size limit");
    }

    const artifactId = ArtifactIdSchema.parse(scope.artifactId);
    const key = `${RUNTIME_TURN_KEY_PREFIX}${artifactId}.json`;
    const sha256 = await sha256Hex(payload);
    const customMetadata = { ...scope, sha256 };
    await this.bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: JSON_CONTENT_TYPE },
      customMetadata,
    });

    // A conditional write can lose a race to another writer for this attempt.
    // Both the new object and an existing object must pass the same readback.
    const stored = await this.bucket.get(key);
    if (
      !stored ||
      stored.size !== bytes.byteLength ||
      stored.httpMetadata?.contentType !== JSON_CONTENT_TYPE ||
      Object.entries(customMetadata).some(
        ([name, value]) => stored.customMetadata?.[name] !== value,
      )
    ) {
      await stored?.body.cancel();
      throw new Error("Canonical artifact metadata is missing or conflicts");
    }

    const actual = new Uint8Array(await stored.arrayBuffer());
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", actual),
    );
    const actualSha256 = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      actual.byteLength !== bytes.byteLength ||
      actualSha256 !== sha256 ||
      actual.some((byte, index) => byte !== bytes[index])
    ) {
      throw new Error("Canonical artifact content conflicts");
    }

    return {
      backend: "r2",
      objectKey: key,
      uri: null,
      contentType: JSON_CONTENT_TYPE,
      sizeBytes: actual.byteLength,
      sha256: actualSha256,
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
