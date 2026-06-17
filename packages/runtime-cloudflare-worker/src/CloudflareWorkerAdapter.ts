import {
  ArtifactAccessContextSchema,
  type ArtifactMetadata,
} from "@repo/artifact-store";
import type {
  GitStatusEntry,
  GitStatusResult,
} from "@repo/git-service";
import {
  RunIdSchema,
  WorkspaceManifestSchema,
  type RunId,
  type WorkspaceManifest,
} from "@repo/platform-protocol";
import {
  ArtifactUploadRequestSchema,
  CommandRunRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  WorkerCapabilitySnapshotSchema,
  WorkspacePrepareRequestSchema,
  WorkspaceRelativePathSchema,
  type ArtifactUploadRequest,
  type CommandRunRequest,
  type CommandRunResponse,
  type FileReadRequest,
  type FileReadResponse,
  type FileWriteRequest,
  type FileWriteResponse,
  type GitChangedFile,
  type GitStatusResponse,
  type WorkerCapabilitySnapshot,
  type WorkspacePrepareRequest,
  type WorkspacePrepareResponse,
} from "@repo/worker-protocol";
import {
  createCloudflareWorkerAdapterError,
  normalizeCloudflareWorkerError,
} from "./errors.js";
import type { CloudflareWorkerAdapterDependencies } from "./types.js";

const CLOUDFLARE_WORKSPACE_ROOT = "/home/sandbox/runs";

export class CloudflareWorkerAdapter {
  private readonly workspaces = new Map<RunId, WorkspaceManifest>();

  constructor(private readonly dependencies: CloudflareWorkerAdapterDependencies) {}

  getCapabilities(): WorkerCapabilitySnapshot {
    return WorkerCapabilitySnapshotSchema.parse(this.dependencies.capabilities);
  }

  async prepareWorkspace(
    runId: RunId,
    request: WorkspacePrepareRequest,
  ): Promise<WorkspacePrepareResponse> {
    return await this.executeTyped("workspace_prepare_failed", async () => {
      const parsedRunId = RunIdSchema.parse(runId);
      const manifest = WorkspacePrepareRequestSchema.parse(request).manifest;
      requireMatchingRun(parsedRunId, manifest);
      requireCanonicalWorkspaceRoot(parsedRunId, manifest.filesystemRoot);
      await this.dependencies.sandbox.prepareWorkspace({
        runId: parsedRunId,
        filesystemRoot: manifest.filesystemRoot,
        repoUrl: manifest.repoUrl,
        baseBranch: manifest.baseBranch,
        workingBranch: manifest.workingBranch,
      });
      this.workspaces.set(parsedRunId, WorkspaceManifestSchema.parse(manifest));
      return {
        filesystemRoot: manifest.filesystemRoot,
        preparedAt: this.now(),
      };
    });
  }

  async runCommand(runId: RunId, request: CommandRunRequest): Promise<CommandRunResponse> {
    return await this.executeTyped("command_failed", async () => {
      const manifest = this.requireWorkspace(runId);
      const payload = CommandRunRequestSchema.parse(request);
      return await this.dependencies.sandbox.runCommand({
        ...payload,
        runId: manifest.runId,
        absoluteCwd: joinWorkspacePath(manifest.filesystemRoot, payload.cwd),
      });
    });
  }

  async readFile(runId: RunId, request: FileReadRequest): Promise<FileReadResponse> {
    return await this.executeTyped("file_not_found", async () => {
      const manifest = this.requireWorkspace(runId);
      const payload = FileReadRequestSchema.parse(request);
      const bytes = await this.dependencies.sandbox.readFile({
        runId: manifest.runId,
        absolutePath: joinWorkspacePath(manifest.filesystemRoot, payload.path),
        maxBytes: payload.maxBytes,
      });
      const limited = payload.maxBytes === null ? bytes : bytes.slice(0, payload.maxBytes);
      return {
        path: payload.path,
        encoding: payload.encoding,
        content: encodePayload(limited, payload.encoding),
        sizeBytes: limited.byteLength,
        sha256: await sha256(limited),
        truncated: limited.byteLength < bytes.byteLength,
      };
    });
  }

  async writeFile(runId: RunId, request: FileWriteRequest): Promise<FileWriteResponse> {
    return await this.executeTyped("file_write_failed", async () => {
      const manifest = this.requireWorkspace(runId);
      const payload = FileWriteRequestSchema.parse(request);
      const bytes = decodePayload(payload.content, payload.encoding);
      await this.dependencies.sandbox.writeFile({
        runId: manifest.runId,
        absolutePath: joinWorkspacePath(manifest.filesystemRoot, payload.path),
        payload: bytes,
        overwrite: payload.overwrite,
        createParents: payload.createParents,
      });
      return {
        path: payload.path,
        sizeBytes: bytes.byteLength,
        sha256: await sha256(bytes),
      };
    });
  }

  async getGitStatus(runId: RunId): Promise<GitStatusResponse> {
    return await this.executeTyped("git_operation_failed", async () => {
      const manifest = this.requireWorkspace(runId);
      const status = await this.dependencies.gitService.getStatus({
        runId: manifest.runId,
        workspaceRoot: manifest.filesystemRoot,
      });
      return mapGitStatus(status);
    });
  }

  async uploadArtifact(
    runId: RunId,
    requestId: string,
    request: ArtifactUploadRequest,
  ): Promise<ArtifactMetadata> {
    return await this.executeTyped("artifact_upload_failed", async () => {
      const manifest = this.requireWorkspace(runId);
      const payload = ArtifactUploadRequestSchema.parse(request);
      const access = ArtifactAccessContextSchema.parse(
        await this.dependencies.artifactAccessResolver.resolve(manifest),
      );
      return await this.dependencies.artifactStore.put({
        idempotencyKey: requestId,
        kind: payload.kind,
        ownership: {
          createdBy: access.userId,
          workspaceId: manifest.workspaceId,
          threadId: requireScopeId(access.threadId, "threadId"),
          runId: manifest.runId,
        },
        visibility: "run",
        contentType: payload.contentType,
        payload: decodePayload(payload.content, payload.encoding),
        properties: {
          ...payload.properties,
          workspacePath: payload.workspacePath,
        },
      }, access);
    });
  }

  private requireWorkspace(runId: RunId): WorkspaceManifest {
    const parsedRunId = RunIdSchema.parse(runId);
    const manifest = this.workspaces.get(parsedRunId);
    if (!manifest) {
      throw createCloudflareWorkerAdapterError(
        "workspace_unavailable",
        `Workspace is not prepared for run ${parsedRunId}`,
      );
    }
    return manifest;
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private async executeTyped<T>(
    code: Parameters<typeof normalizeCloudflareWorkerError>[1],
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeCloudflareWorkerError(error, code);
    }
  }
}

function requireMatchingRun(runId: RunId, manifest: WorkspaceManifest): void {
  if (manifest.runId !== runId) {
    throw createCloudflareWorkerAdapterError(
      "validation_failed",
      "Workspace manifest runId must match the adapter runId",
    );
  }
}

function requireCanonicalWorkspaceRoot(runId: RunId, root: string): void {
  if (root !== `${CLOUDFLARE_WORKSPACE_ROOT}/${runId}`) {
    throw createCloudflareWorkerAdapterError(
      "path_denied",
      "Cloudflare workspace root must be scoped to its runId",
    );
  }
}

function joinWorkspacePath(root: string, path: string | null): string {
  return path === null ? root : `${root}/${WorkspaceRelativePathSchema.parse(path)}`;
}

function requireScopeId<T>(value: T | null, field: string): T {
  if (value === null) {
    throw createCloudflareWorkerAdapterError(
      "validation_failed",
      `Artifact access ${field} is required`,
    );
  }
  return value;
}

function mapGitStatus(status: GitStatusResult): GitStatusResponse {
  return {
    branch: {
      head: status.branch.head,
      upstream: status.branch.upstream,
      headSha: status.branch.oid,
      ahead: status.branch.ahead,
      behind: status.branch.behind,
      detached: status.branch.detached,
    },
    files: status.entries.map(mapGitStatusEntry),
    changedFileCount: status.changedFileCount,
    isDirty: status.isDirty,
  };
}

function mapGitStatusEntry(entry: GitStatusEntry): GitChangedFile {
  return {
    path: WorkspaceRelativePathSchema.parse(entry.path),
    previousPath: entry.kind === "renamed_or_copied"
      ? WorkspaceRelativePathSchema.parse(entry.previousPath)
      : null,
    status: entry.status,
    additions: null,
    deletions: null,
  };
}

function decodePayload(content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "utf8") {
    return new TextEncoder().encode(content);
  }
  return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
}

function encodePayload(payload: Uint8Array, encoding: "utf8" | "base64"): string {
  if (encoding === "utf8") {
    return new TextDecoder().decode(payload);
  }
  return btoa(String.fromCharCode(...payload));
}

async function sha256(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(payload).buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
