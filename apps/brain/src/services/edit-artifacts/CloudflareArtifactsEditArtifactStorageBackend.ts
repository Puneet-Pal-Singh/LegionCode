import {
  sha256Hex,
  type EditArtifactStorageBackend,
  type StoredEditArtifact,
  type WriteEditArtifactInput,
} from "./EditArtifactStorageBackend";

interface ArtifactsBinding {
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
  constructor(private readonly artifacts: ArtifactsBinding) {}

  async writeArtifact(
    input: WriteEditArtifactInput,
  ): Promise<StoredEditArtifact> {
    const repoName = buildRepoName(input.workspaceId);
    await this.ensureRepo(repoName);
    throw new CloudflareArtifactsWriteUnavailableError();
  }

  async readPatch(): Promise<string | null> {
    return null;
  }

  async deleteArtifact(): Promise<void> {
    return;
  }

  private async ensureRepo(repoName: string): Promise<ArtifactsRepoMetadata> {
    try {
      await this.artifacts.get(repoName);
      return { name: repoName, remote: "", defaultBranch: "main" };
    } catch {
      return await this.artifacts.create(repoName, {
        description: "LegionCode edit artifacts",
        readOnly: false,
        setDefaultBranch: "main",
      });
    }
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

function buildRepoName(workspaceId: string): string {
  return `workspace-${workspaceId}`;
}
