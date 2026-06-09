import { describe, expect, it } from "vitest";
import {
  WorkspaceManifestError,
  assertWorkspaceManifestIdentityUnchanged,
  transitionWorkspaceManifestState,
} from "./types.js";

const manifest = {
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
  createdAt: "2026-06-09T12:00:00.000Z",
  updatedAt: "2026-06-09T12:00:00.000Z",
} as const;

describe("workspace manifest invariants", () => {
  it("allows only explicit state transitions", () => {
    expect(transitionWorkspaceManifestState("preparing", "ready")).toBe(
      "ready",
    );
    expect(transitionWorkspaceManifestState("ready", "dirty")).toBe("dirty");
    expect(() =>
      transitionWorkspaceManifestState("archived", "ready"),
    ).toThrow(WorkspaceManifestError);
  });

  it("enforces immutable identity fields", () => {
    expect(() =>
      assertWorkspaceManifestIdentityUnchanged(manifest, {
        ...manifest,
        headCommitSha: "c".repeat(40),
        state: "dirty",
        updatedAt: "2026-06-09T13:00:00.000Z",
      }),
    ).not.toThrow();

    expect(() =>
      assertWorkspaceManifestIdentityUnchanged(manifest, {
        ...manifest,
        baseBranch: "main",
      }),
    ).toThrow(WorkspaceManifestError);
  });
});
