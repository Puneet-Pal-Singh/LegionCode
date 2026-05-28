import {
  sha256Hex,
  type EditArtifactStorageBackend,
  type StoredEditArtifact,
} from "./EditArtifactStorageBackend";

export interface ArtifactsBinding {
  create(
    name: string,
    options?: {
      description?: string;
      readOnly?: boolean;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsRepoMetadata>;
  get(name: string): Promise<ArtifactsRepoHandle>;
}

interface ArtifactsRepoMetadata {
  name: string;
  remote: string;
  defaultBranch?: string;
  token?: string;
}

interface ArtifactsRepoHandle {
  createToken(scope: "read" | "write", expiresInSeconds: number): Promise<string>;
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

export function buildRepoName(workspaceId: string): string {
  return `workspace-${workspaceId}`;
}
