import { describe, expect, it } from "vitest";
import { WorkspaceCoreError } from "./errors.js";
import {
  parseWorkspaceManifest,
  validateWorkspaceManifestUpdate,
} from "./manifest.js";

const timestamp = "2026-06-08T15:00:00.000Z";

const baseManifest = parseWorkspaceManifest({
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
});

describe("workspace manifest", () => {
  it("accepts the canonical manifest shape", () => {
    expect(parseWorkspaceManifest(baseManifest)).toEqual(baseManifest);
  });

  it("rejects missing run identifiers with a typed fatal error", () => {
    const missingRunId: Record<string, unknown> = { ...baseManifest };
    delete missingRunId.runId;

    expect(() => parseWorkspaceManifest(missingRunId)).toThrow(
      expect.objectContaining({
        code: "workspace_missing_run_id",
        name: "WorkspaceCoreError",
      }),
    );
  });

  it("rejects immutable identity and configuration field changes", () => {
    const next = {
      ...baseManifest,
      baseBranch: "main",
      headSha: "c".repeat(40),
      state: "dirty",
      updatedAt: "2026-06-08T15:01:00.000Z",
    };

    expect(() => validateWorkspaceManifestUpdate(baseManifest, next)).toThrow(
      expect.objectContaining({
        code: "workspace_immutable_field_changed",
        context: { changedFields: ["baseBranch"] },
      }),
    );
  });

  it("allows mutable state, head, error, and update timestamp fields to change", () => {
    const next = {
      ...baseManifest,
      headSha: "c".repeat(40),
      state: "dirty",
      lastError: "Working tree has unstaged changes",
      updatedAt: "2026-06-08T15:01:00.000Z",
    };

    expect(validateWorkspaceManifestUpdate(baseManifest, next)).toEqual(next);
  });

  it("exposes typed errors for invalid manifest updates", () => {
    const next = {
      ...baseManifest,
      state: "pushed",
    };

    try {
      validateWorkspaceManifestUpdate(baseManifest, next);
      throw new Error("Expected update validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceCoreError);
      expect((error as WorkspaceCoreError).code).toBe(
        "workspace_transition_invalid",
      );
    }
  });
});
