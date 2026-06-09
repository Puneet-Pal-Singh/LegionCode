import { describe, expect, it } from "vitest";
import { RunIdSchema, WorkspaceIdSchema } from "@repo/platform-protocol";
import { WorkspaceCoreError } from "./errors.js";
import { parseWorkspaceManifest, type WorkspaceManifest } from "./manifest.js";
import { MemoryWorkspaceManifestRepository } from "./repository.js";

const timestamp = "2026-06-08T15:00:00.000Z";

function buildManifest(
  overrides: Partial<WorkspaceManifest> = {},
): WorkspaceManifest {
  return parseWorkspaceManifest({
    runId: "run_abc123",
    workspaceId: "wrk_abc123",
    repoOwner: "Puneet-Pal-Singh",
    repoName: "LegionCode",
    repoUrl: "https://github.com/Puneet-Pal-Singh/LegionCode",
    baseBranch: "dev",
    workingBranch: "rebuild/002-workspace-core",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    executionLocation: "cloud_sandbox",
    workerId: "worker_abc123",
    filesystemRoot: "/home/sandbox/runs/run_abc123",
    artifactNamespace: "runs/run_abc123/artifacts",
    permissionProfileId: "perm_abc123",
    state: "ready",
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

describe("memory workspace manifest repository", () => {
  it("creates and reads manifests without exposing mutable storage", async () => {
    const repository = new MemoryWorkspaceManifestRepository();
    const manifest = buildManifest();

    const created = await repository.create(manifest);
    created.state = "failed";

    await expect(repository.getByWorkspaceId(manifest.workspaceId)).resolves
      .toMatchObject({
        workspaceId: manifest.workspaceId,
        state: "ready",
      });
  });

  it("returns the latest manifest for a run", async () => {
    const repository = new MemoryWorkspaceManifestRepository();
    await repository.create(
      buildManifest({ workspaceId: WorkspaceIdSchema.parse("wrk_first123") }),
    );
    await repository.create(
      buildManifest({ workspaceId: WorkspaceIdSchema.parse("wrk_second123") }),
    );

    await expect(
      repository.getLatestByRunId(RunIdSchema.parse("run_abc123")),
    ).resolves.toMatchObject({
        workspaceId: "wrk_second123",
      });
  });

  it("rejects duplicate workspace identifiers", async () => {
    const repository = new MemoryWorkspaceManifestRepository();
    const manifest = buildManifest();

    await repository.create(manifest);
    await expect(repository.create(manifest)).rejects.toEqual(
      expect.objectContaining({
        code: "workspace_manifest_already_exists",
      }),
    );
  });

  it("updates manifests through canonical transition validation", async () => {
    const repository = new MemoryWorkspaceManifestRepository();
    const manifest = buildManifest();
    await repository.create(manifest);

    const updated = await repository.update({
      ...manifest,
      headSha: "c".repeat(40),
      state: "dirty",
      updatedAt: "2026-06-08T15:01:00.000Z",
    });

    expect(updated.state).toBe("dirty");
    await expect(repository.getByWorkspaceId(manifest.workspaceId)).resolves
      .toMatchObject({
        headSha: "c".repeat(40),
        state: "dirty",
      });
  });

  it("rejects updates for missing manifests", async () => {
    const repository = new MemoryWorkspaceManifestRepository();

    await expect(repository.update(buildManifest())).rejects.toBeInstanceOf(
      WorkspaceCoreError,
    );
  });
});
