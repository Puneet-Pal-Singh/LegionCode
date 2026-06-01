import {
  sha256Hex,
  type EditArtifactStorageBackend,
  type StoredEditArtifact,
} from "./EditArtifactStorageBackend";

interface ArtifactsBinding {
  get(name: string): Promise<unknown>;
}

export class CloudflareArtifactsWriteUnavailableError extends Error {
  constructor() {
    super(
      "Cloudflare Artifacts secondary writes require a Git writer in this runtime.",
    );
    this.name = "CloudflareArtifactsWriteUnavailableError";
  }
}

export class CloudflareArtifactsEditArtifactStorageBackend
  implements EditArtifactStorageBackend
{
  constructor(_artifacts: ArtifactsBinding) {}

  async writeArtifact(): Promise<StoredEditArtifact> {
    throw new CloudflareArtifactsWriteUnavailableError();
  }

  async readPatch(): Promise<string | null> {
    return null;
  }

  async deleteArtifact(): Promise<void> {
    return;
  }
}

export function buildCloudflareArtifactPath(input: {
  runId: string;
  artifactId: string;
}): string {
  return `runs/${input.runId}/artifacts/${input.artifactId}`;
}

export async function buildCloudflareArtifactCommitSha(
  patch: string,
): Promise<string> {
  return await sha256Hex(patch);
}
