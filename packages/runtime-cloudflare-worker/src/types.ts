import type { ArtifactAccessContext, ArtifactStore } from "@repo/artifact-store";
import type { GitService } from "@repo/git-service";
import type {
  RunId,
  WorkspaceManifest,
} from "@repo/platform-protocol";
import type {
  CommandRunRequest,
  CommandRunResponse,
  WorkerCapabilitySnapshot,
} from "@repo/worker-protocol";

export interface CloudflareWorkspacePreparationInput {
  readonly runId: RunId;
  readonly filesystemRoot: string;
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly workingBranch: string;
}

export interface CloudflareFileReadInput {
  readonly runId: RunId;
  readonly absolutePath: string;
  readonly maxBytes: number | null;
}

export interface CloudflareFileWriteInput {
  readonly runId: RunId;
  readonly absolutePath: string;
  readonly payload: Uint8Array;
  readonly overwrite: boolean;
  readonly createParents: boolean;
}

export interface CloudflareCommandInput extends CommandRunRequest {
  readonly runId: RunId;
  readonly absoluteCwd: string;
}

export interface CloudflareSandboxBridge {
  prepareWorkspace(input: CloudflareWorkspacePreparationInput): Promise<void>;
  runCommand(input: CloudflareCommandInput): Promise<CommandRunResponse>;
  readFile(input: CloudflareFileReadInput): Promise<Uint8Array>;
  writeFile(input: CloudflareFileWriteInput): Promise<void>;
}

export interface ArtifactAccessResolver {
  resolve(manifest: WorkspaceManifest): Promise<ArtifactAccessContext>;
}

export interface CloudflareWorkerAdapterDependencies {
  readonly sandbox: CloudflareSandboxBridge;
  readonly gitService: GitService;
  readonly artifactStore: ArtifactStore;
  readonly artifactAccessResolver: ArtifactAccessResolver;
  readonly capabilities: WorkerCapabilitySnapshot;
  readonly now?: () => string;
}
