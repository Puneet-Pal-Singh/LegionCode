import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRepository } from "@repo/persistence";
import type { EditArtifactRecord, GitStatusResponse } from "@repo/shared-types";
import type { Env } from "../../types/ai";

const artifactFactory = vi.hoisted(() => ({
  withArtifactRepository: vi.fn(),
}));

const gitClientMocks = vi.hoisted(() => ({
  applyPatch: vi.fn(),
}));

vi.mock("./ArtifactPersistenceFactory", () => ({
  withArtifactRepository: artifactFactory.withArtifactRepository,
}));

vi.mock("./SecureGitArtifactClient", () => ({
  SecureGitArtifactClient: vi.fn(() => ({
    applyPatch: gitClientMocks.applyPatch,
  })),
}));

import { EditArtifactRestoreService } from "./EditArtifactRestoreService";

describe("EditArtifactRestoreService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    artifactFactory.withArtifactRepository.mockReset();
    gitClientMocks.applyPatch.mockReset();
  });

  it("deduplicates concurrent restore attempts for the same user and run", async () => {
    let resolvePatchApply: (() => void) | null = null;
    const artifact = createArtifact();
    const repository = createRepository(artifact);
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(repository),
    );
    gitClientMocks.applyPatch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePatchApply = resolve;
        }),
    );

    const service = new EditArtifactRestoreService(createEnv());
    const input = {
      userId: "user-1",
      runId: "run-1",
      muscleSession: "muscle-run-1",
      currentStatus: createEmptyGitStatus(),
    };

    const firstRestore = service.restoreLatestIfWorkspaceIsEmpty(input);
    const secondRestore = service.restoreLatestIfWorkspaceIsEmpty(input);

    expect(repository.getLatestRestorableArtifact).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(gitClientMocks.applyPatch).toHaveBeenCalledTimes(1);
    });

    resolvePatchApply?.();

    await expect(Promise.all([firstRestore, secondRestore])).resolves.toEqual([
      "restored",
      "restored",
    ]);
    expect(repository.updateStatus).toHaveBeenCalledTimes(2);
  });
});

function createEnv(): Env {
  return {
    EDIT_ARTIFACTS: new MockR2Bucket() as Env["EDIT_ARTIFACTS"],
  } as Env;
}

function createRepository(artifact: EditArtifactRecord): ArtifactRepository {
  const repository = {
    createPendingArtifact: vi.fn(),
    appendEvent: vi.fn(async (input) => ({
      id: input.id,
      artifactId: input.artifactId,
      runId: input.runId,
      eventType: input.eventType,
      message: input.message,
      metadata: input.metadata ?? null,
      createdAt: input.createdAt ?? "2026-05-23T00:00:00.000Z",
    })),
    updateStatus: vi.fn(async (input) => ({
      ...artifact,
      status: input.status,
    })),
    getLatestRestorableArtifact: vi.fn(async () => artifact),
    listExpiredArtifacts: vi.fn(async () => []),
    listStalePendingArtifacts: vi.fn(async () => []),
    transaction: vi.fn(),
  } satisfies ArtifactRepository;
  repository.transaction.mockImplementation(
    async (callback) => await callback(repository),
  );
  return repository;
}

function createArtifact(): EditArtifactRecord {
  return {
    id: "artifact-1",
    userId: "user-1",
    runId: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    repoOwner: "owner",
    repoName: "repo",
    repoUrl: "https://github.com/owner/repo",
    branch: "main",
    baseCommitSha: "base-sha",
    headCommitSha: null,
    artifactKind: "git_patch",
    r2ObjectKey: "edit-artifacts/user-1/workspace-1/run-1/artifact-1/diff.patch",
    contentType: "text/x-patch",
    sizeBytes: 10,
    sha256: "sha256",
    changedFileCount: 1,
    changedFiles: [{ path: "src/main.ts", status: "modified" }],
    status: "stored",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    expiresAt: "2026-06-23T00:00:00.000Z",
  };
}

function createEmptyGitStatus(): GitStatusResponse {
  return {
    files: [],
    ahead: 0,
    behind: 0,
    branch: "main",
    hasStaged: false,
    hasUnstaged: false,
    gitAvailable: true,
  };
}

class MockR2Bucket {
  async get(): Promise<{ text: () => Promise<string> }> {
    return {
      text: async () => "diff --git a/src/main.ts b/src/main.ts",
    };
  }
}
