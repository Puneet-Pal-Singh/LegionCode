import type {
  EditArtifactChangedFile,
  EditArtifactPatchObjectMetadata,
  EditArtifactRecord,
} from "@repo/shared-types";

export interface WriteEditArtifactInput {
  artifactId: string;
  userId: string;
  workspaceId: string;
  runId: string;
  sessionId: string;
  objectKey: string;
  patch: string;
  metadata: EditArtifactPatchObjectMetadata;
}

export interface StoredEditArtifact {
  backend: "r2_postgres" | "cloudflare_artifacts";
  objectKey?: string;
  cfRepo?: string;
  cfCommitSha?: string;
  cfPath?: string;
  patchSha256: string;
}

export interface EditArtifactStorageBackend {
  writeArtifact(input: WriteEditArtifactInput): Promise<StoredEditArtifact>;
  readPatch(input: { artifact: EditArtifactRecord }): Promise<string | null>;
  deleteArtifact(input: { artifact: EditArtifactRecord }): Promise<void>;
}

export interface EditArtifactStorageMetadata {
  changedFiles: EditArtifactChangedFile[];
  capturedAt: string;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
