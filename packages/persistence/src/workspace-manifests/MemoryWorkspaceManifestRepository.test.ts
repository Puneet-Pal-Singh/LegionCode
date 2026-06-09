import { describe, expect, it } from "vitest";
import type { WorkspaceManifest } from "@repo/platform-protocol";
import { MemoryWorkspaceManifestRepository } from "./MemoryWorkspaceManifestRepository.js";
import { WorkspaceManifestError } from "./types.js";

const manifest: WorkspaceManifest = {
  manifestId: "wsm_abc123",
  workspaceId: "wrk_abc123",
  runId: "run_abc123",
  userId: "usr_abc123",
  workerId: "worker_abc123",
  permissionProfileId: "perm_abc123",
  repoOwner: "Puneet-Pal-Singh",
  repoName: "LegionCode",
  repoUrl: "https://github.com/Puneet-Pal-Singh/LegionCode",
  baseBranch: "dev",
  workingBranch: "feat/workspace-artifact-persistence",
  baseCommitSha: "a".repeat(40),
  headCommitSha: "b".repeat(40),
  executionLocation: "cloud_sandbox",
  filesystemRoot: "/home/sandbox/runs/run_abc123",
  artifactNamespace: "runs/run_abc123/artifacts",
  state: "preparing",
  lastError: null,
  createdAt: "2026-06-09T12:00:00.000Z",
  updatedAt: "2026-06-09T12:00:00.000Z",
};

describe("MemoryWorkspaceManifestRepository", () => {
  it("saves, transitions, and reads the latest manifest for a run", async () => {
    const repository = new MemoryWorkspaceManifestRepository();

    await repository.saveManifest({ manifest });
    const ready = await repository.transitionManifest({
      manifestId: "wsm_abc123",
      nextState: "ready",
      headCommitSha: "c".repeat(40),
      lastError: null,
      updatedAt: "2026-06-09T13:00:00.000Z",
    });
    const latest = await repository.getLatestManifestForRun("run_abc123");

    expect(ready.state).toBe("ready");
    expect(ready.headCommitSha).toBe("c".repeat(40));
    expect(latest?.manifestId).toBe("wsm_abc123");
  });

  it("rejects identity changes on save", async () => {
    const repository = new MemoryWorkspaceManifestRepository();

    await repository.saveManifest({ manifest });

    await expect(
      repository.saveManifest({
        manifest: {
          ...manifest,
          repoUrl: "https://github.com/other/repo",
        },
      }),
    ).rejects.toThrow(WorkspaceManifestError);
  });
});
