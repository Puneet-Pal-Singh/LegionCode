import { describe, expect, it } from "vitest";

interface WorkspaceManifest {
  runId: string;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  baseBranch: string;
  workingBranch: string;
  baseSha: string;
  headSha: string;
  executionLocation: "cloud_sandbox";
  workerId: string;
  filesystemRoot: string;
  artifactNamespace: string;
  permissionProfileId: string;
  state: "ready" | "dirty" | "pushed";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceManifestRepositoryContract {
  create(manifest: WorkspaceManifest): Promise<WorkspaceManifest>;
  update(manifest: WorkspaceManifest): Promise<WorkspaceManifest>;
  getLatestByRunId(runId: string): Promise<WorkspaceManifest | null>;
}

export function registerWorkspaceRepositoryConformance(
  implementation: string,
  createRepository: () => unknown | Promise<unknown>,
): void {
  describe(`${implementation} WorkspaceManifestRepository conformance`, () => {
    it("preserves canonical lifecycle updates and latest-run lookup", async () => {
      const repository =
        (await createRepository()) as WorkspaceManifestRepositoryContract;
      const manifest = createManifest();
      await repository.create(manifest);
      await repository.update({
        ...manifest,
        state: "dirty",
        headSha: "c".repeat(40),
        updatedAt: "2026-06-15T00:01:00.000Z",
      });

      await expect(repository.getLatestByRunId(manifest.runId)).resolves.toMatchObject({
        state: "dirty",
        headSha: "c".repeat(40),
      });
    });

    it("rejects duplicate identity and invalid lifecycle transitions with typed errors", async () => {
      const repository =
        (await createRepository()) as WorkspaceManifestRepositoryContract;
      const manifest = createManifest();
      await repository.create(manifest);

      await expect(repository.create(manifest)).rejects.toMatchObject({
        code: "workspace_manifest_already_exists",
      });
      await expect(
        repository.update({ ...manifest, state: "pushed" }),
      ).rejects.toMatchObject({ code: "workspace_transition_invalid" });
    });
  });
}

function createManifest(): WorkspaceManifest {
  return {
    runId: "run_conformance",
    workspaceId: "wrk_conformance",
    repoOwner: "owner",
    repoName: "repo",
    repoUrl: "https://example.com/owner/repo",
    baseBranch: "dev",
    workingBranch: "test/conformance",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    executionLocation: "cloud_sandbox",
    workerId: "worker_conformance",
    filesystemRoot: "/home/sandbox/runs/run_conformance",
    artifactNamespace: "runs/run_conformance/artifacts",
    permissionProfileId: "perm_conformance",
    state: "ready",
    lastError: null,
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  };
}
