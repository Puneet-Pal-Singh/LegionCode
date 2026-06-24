import {
  ArtifactAccessContextSchema,
  InMemoryArtifactStore,
  type ArtifactAuthorizer,
} from "@repo/artifact-store";
import type { GitService, GitStatusResult } from "@repo/git-service";
import { RunIdSchema, WorkspaceManifestSchema } from "@repo/platform-protocol";
import {
  ArtifactUploadRequestSchema,
  CommandRunRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  WorkerCapabilitySnapshotSchema,
} from "@repo/worker-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareWorkerAdapter } from "./CloudflareWorkerAdapter.js";
import type { CloudflareSandboxBridge } from "./types.js";

const RUN_ID = RunIdSchema.parse("run_cloudflare1");
const WORKSPACE_ROOT = `/home/sandbox/runs/${RUN_ID}`;

describe("CloudflareWorkerAdapter", () => {
  let sandbox: CloudflareSandboxBridge;
  let gitService: GitService;
  let artifactStore: InMemoryArtifactStore;
  let adapter: CloudflareWorkerAdapter;

  beforeEach(() => {
    sandbox = createSandbox();
    gitService = createGitService();
    artifactStore = new InMemoryArtifactStore({
      authorizer: { authorize: async () => true } satisfies ArtifactAuthorizer,
    });
    adapter = new CloudflareWorkerAdapter({
      sandbox,
      gitService,
      artifactStore,
      artifactAccessResolver: {
        resolve: async () =>
          ArtifactAccessContextSchema.parse({
            userId: "usr_cloudflare1",
            workspaceId: "wrk_cloudflare1",
            threadId: "thr_cloudflare1",
            runId: RUN_ID,
          }),
      },
      capabilities: createCapabilities(),
      now: () => "2026-06-15T00:00:00.000Z",
    });
  });

  it("reports capabilities and prepares an isolated workspace", async () => {
    expect(adapter.getCapabilities()).toMatchObject({
      backendKind: "cloud_sandbox",
      supportsGit: true,
    });

    await expect(
      adapter.prepareWorkspace(RUN_ID, { manifest: createManifest() }),
    ).resolves.toEqual({
      filesystemRoot: WORKSPACE_ROOT,
      preparedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(sandbox.prepareWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        filesystemRoot: WORKSPACE_ROOT,
      }),
    );
  });

  it("runs commands and reads and writes files inside the prepared workspace", async () => {
    await prepare(adapter);
    await expect(
      adapter.runCommand(
        RUN_ID,
        CommandRunRequestSchema.parse({
          argv: ["pnpm", "test"],
          cwd: "packages/worker-protocol",
          env: { CI: "true" },
          stdin: null,
          timeoutMs: 30_000,
        }),
      ),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });

    const write = await adapter.writeFile(
      RUN_ID,
      FileWriteRequestSchema.parse({
        path: "tmp/result.txt",
        encoding: "utf8",
        content: "hello",
        overwrite: true,
        createParents: true,
      }),
    );
    expect(write.sizeBytes).toBe(5);
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: `${WORKSPACE_ROOT}/tmp/result.txt`,
      }),
    );

    await expect(
      adapter.readFile(
        RUN_ID,
        FileReadRequestSchema.parse({
          path: "tmp/result.txt",
          encoding: "utf8",
          maxBytes: null,
        }),
      ),
    ).resolves.toMatchObject({ content: "hello", sizeBytes: 5 });
  });

  it("routes git status through the canonical Git service", async () => {
    await prepare(adapter);
    const status = await adapter.getGitStatus(RUN_ID);
    expect(gitService.getStatus).toHaveBeenCalledWith({
      runId: RUN_ID,
      workspaceRoot: WORKSPACE_ROOT,
    });
    expect(status).toMatchObject({
      isDirty: true,
      files: [{ path: "src/index.ts", status: "modified" }],
    });
  });

  it("uploads artifacts through the canonical artifact store", async () => {
    await prepare(adapter);
    const metadata = await adapter.uploadArtifact(
      RUN_ID,
      "req-artifact-upload",
      ArtifactUploadRequestSchema.parse({
        kind: "command_log",
        contentType: "text/plain",
        encoding: "utf8",
        content: "hello",
        workspacePath: null,
        properties: { command: "pnpm test" },
      }),
    );

    expect(metadata).toMatchObject({
      kind: "command_log",
      ownership: { runId: RUN_ID, workspaceId: "wrk_cloudflare1" },
      payload: { byteSize: 5 },
    });
    await expect(
      artifactStore.getPayload(
        metadata.artifactId,
        ArtifactAccessContextSchema.parse({
          userId: "usr_cloudflare1",
          workspaceId: "wrk_cloudflare1",
          threadId: "thr_cloudflare1",
          runId: RUN_ID,
        }),
      ),
    ).resolves.toEqual(new TextEncoder().encode("hello"));
  });

  it("returns typed errors for unavailable and incorrectly scoped workspaces", async () => {
    await expect(
      adapter.readFile(
        RUN_ID,
        FileReadRequestSchema.parse({
          path: "tmp/result.txt",
          encoding: "utf8",
          maxBytes: null,
        }),
      ),
    ).rejects.toMatchObject({
      protocolError: { code: "workspace_unavailable" },
    });

    await expect(
      adapter.prepareWorkspace(RUN_ID, {
        manifest: createManifest("/home/sandbox/runs/run_other123"),
      }),
    ).rejects.toMatchObject({
      protocolError: { code: "path_denied" },
    });
  });
});

function prepare(adapter: CloudflareWorkerAdapter): Promise<unknown> {
  return adapter.prepareWorkspace(RUN_ID, { manifest: createManifest() });
}

function createManifest(filesystemRoot = WORKSPACE_ROOT) {
  return WorkspaceManifestSchema.parse({
    manifestId: "wsm_cloudflare1",
    workspaceId: "wrk_cloudflare1",
    runId: RUN_ID,
    userId: "usr_cloudflare1",
    workerId: "worker_cloudflare1",
    permissionProfileId: "perm_cloudflare1",
    repoOwner: "owner",
    repoName: "repo",
    repoUrl: "https://example.com/owner/repo.git",
    baseBranch: "dev",
    workingBranch: "feat/example",
    baseCommitSha: "abcdef1",
    headCommitSha: "abcdef1",
    executionLocation: "cloud_sandbox",
    filesystemRoot,
    artifactNamespace: `runs/${RUN_ID}`,
    state: "preparing",
    lastError: null,
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  });
}

function createCapabilities() {
  return WorkerCapabilitySnapshotSchema.parse({
    workerId: "worker_cloudflare1",
    workerKind: "cloud",
    backendKind: "cloud_sandbox",
    version: "1.0.0",
    supportsShell: true,
    supportsGit: true,
    supportsSnapshots: false,
    supportsBrowser: false,
    supportsLongRunningProcesses: false,
    supportsNetworkEgress: true,
    maxRuntimeSeconds: 900,
    maxWorkspaceBytes: 1_000_000,
    isolationStrength: "sandbox",
    supportedLanguages: ["typescript"],
    artifactStoreKind: "r2",
    supportedOperations: [
      "worker.capabilities",
      "workspace.prepare",
      "command.run",
      "file.read",
      "file.write",
      "git.status",
      "artifact.upload",
    ],
    capturedAt: "2026-06-15T00:00:00.000Z",
  });
}

function createSandbox(): CloudflareSandboxBridge {
  return {
    prepareWorkspace: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      signal: null,
    })),
    readFile: vi.fn(async () => new TextEncoder().encode("hello")),
    writeFile: vi.fn(async () => undefined),
  };
}

function createGitService(): GitService {
  const status: GitStatusResult = {
    branch: {
      oid: "abcdef1",
      head: "feat/example",
      upstream: "origin/feat/example",
      ahead: 0,
      behind: 0,
      detached: false,
    },
    entries: [
      {
        kind: "ordinary",
        status: "modified",
        path: "src/index.ts",
        xy: { index: ".", worktree: "M" },
        submodule: "N...",
        headMode: "100644",
        indexMode: "100644",
        worktreeMode: "100644",
        headObjectId: "abcdef1",
        indexObjectId: "abcdef1",
      },
    ],
    changedFileCount: 1,
    isDirty: true,
  };
  return {
    getStatus: vi.fn(async () => status),
    getDiff: vi.fn(async () => ({ files: [], patch: "" })),
    getFileLineCounts: vi.fn(async () => []),
    getUntrackedFileDiff: vi.fn(async () => null),
    getRepoIdentity: vi.fn(async () => null),
    readConfigValue: vi.fn(async () => null),
    capturePatch: vi.fn(async () => ({
      patch: "",
      baseCommitSha: null,
      branch: null,
    })),
    captureSnapshot: vi.fn(async ({ workspace }) => ({
      runId: workspace.runId,
      filesystemRoot: workspace.filesystemRoot,
      headSha: "a".repeat(40),
      treeId: "b".repeat(40),
    })),
    getSnapshotDiff: vi.fn(async () => ({ files: [], patch: "" })),
    stageFiles: vi.fn(async () => status),
    unstageFiles: vi.fn(async () => status),
    commit: vi.fn(async () => ({
      commitSha: "abcdef1",
      branchName: "feat/example",
      committedPaths: [],
    })),
    push: vi.fn(async () => ({
      remoteName: "origin",
      branchName: "feat/example",
      headSha: "abcdef1",
    })),
    pull: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    createBranch: vi.fn(async ({ branchName }) => ({
      branchName,
      message: `Created and switched to branch: ${branchName}`,
    })),
    switchBranch: vi.fn(async ({ branchName }) => ({
      branchName,
      message: `Switched to branch: ${branchName}`,
    })),
    listBranches: vi.fn(async () => ({ output: "* feat/example\n" })),
    validateBranch: vi.fn(async ({ branchName }) => ({
      branchName,
      checkedRef: branchName,
    })),
  };
}
