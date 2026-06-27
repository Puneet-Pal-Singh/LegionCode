import { describe, expect, it } from "vitest";
import { WorkspaceManifestSchema } from "./workspaces.js";

const timestamp = "2026-06-08T15:00:00.000Z";

describe("workspace protocol schemas", () => {
  it("accepts a durable workspace manifest shape", () => {
    const manifest = WorkspaceManifestSchema.parse({
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
      state: "ready",
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(manifest.state).toBe("ready");
    expect(manifest.repoName).toBe("LegionCode");
  });

  it("rejects malformed commit identities", () => {
    expect(() =>
      WorkspaceManifestSchema.parse({
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
        baseCommitSha: "not-a-sha",
        headCommitSha: "b".repeat(40),
        executionLocation: "cloud_sandbox",
        filesystemRoot: "/home/sandbox/runs/run_abc123",
        artifactNamespace: "runs/run_abc123/artifacts",
        state: "ready",
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow();
  });
});
