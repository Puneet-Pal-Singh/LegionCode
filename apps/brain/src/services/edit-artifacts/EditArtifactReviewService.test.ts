import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRepository } from "@repo/persistence";
import type { EditArtifactRecord } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { EditArtifactReviewService } from "./EditArtifactReviewService";
import { sha256Hex } from "./EditArtifactStorageBackend";

const artifactFactory = vi.hoisted(() => ({
  withArtifactRepository: vi.fn(),
}));

vi.mock("./ArtifactPersistenceFactory", () => ({
  withArtifactRepository: artifactFactory.withArtifactRepository,
}));

const PATCH = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1 +1 @@
-console.log("old");
+console.log("new");
`;

describe("EditArtifactReviewService", () => {
  beforeEach(() => {
    artifactFactory.withArtifactRepository.mockReset();
  });

  it("serves a saved artifact diff without reading live git", async () => {
    const env = createEnv();
    const artifact = await createStoredArtifact(env);
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(createRepository(artifact)),
    );

    const service = new EditArtifactReviewService(env);
    const response = await service.getArtifactDiff({
      artifactId: artifact.id,
      userId: artifact.userId,
      path: "src/main.ts",
    });

    expect(response.source).toBe("artifact_patch");
    expect(response.diff.hunks[0]?.lines).toEqual([
      { type: "deleted", content: 'console.log("old");', oldLineNumber: 1 },
      { type: "added", content: 'console.log("new");', newLineNumber: 1 },
    ]);
  });

  it("rejects a corrupt saved artifact patch", async () => {
    const env = createEnv();
    const artifact = await createStoredArtifact(env, "not-the-real-sha");
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(createRepository(artifact)),
    );

    const service = new EditArtifactReviewService(env);
    await expect(
      service.getArtifactDiff({
        artifactId: artifact.id,
        userId: artifact.userId,
        path: "src/main.ts",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATCH_CORRUPT" });
  });

  it("rejects an artifact with no saved patch", async () => {
    const env = createEnv();
    const artifact = createArtifact("sha256");
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(createRepository(artifact)),
    );

    const service = new EditArtifactReviewService(env);
    await expect(
      service.getArtifactDiff({
        artifactId: artifact.id,
        userId: artifact.userId,
        path: "src/main.ts",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATCH_MISSING" });
  });

  it("rejects an artifact not owned by the requesting user", async () => {
    const env = createEnv();
    const artifact = await createStoredArtifact(env);
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(
        createRepository(null) as unknown as ArtifactRepository,
      ),
    );

    const service = new EditArtifactReviewService(env);
    await expect(
      service.getArtifactDiff({
        artifactId: artifact.id,
        userId: "other-user",
        path: "src/main.ts",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_UNAUTHORIZED" });
  });

  it("returns review source for latest artifact", async () => {
    const env = createEnv();
    const artifact = await createStoredArtifact(env);
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(createRepository(artifact)),
    );

    const service = new EditArtifactReviewService(env);
    const source = await service.getLatestReviewSource({
      runId: artifact.runId,
      userId: artifact.userId,
    });

    expect(source).not.toBeNull();
    expect(source!.kind).toBe("prompt_artifact");
    expect(source!.artifactId).toBe(artifact.id);
    expect(source!.files).toHaveLength(1);
    expect(source!.files[0]!.status).toBe("modified");
  });

  it("returns null when no artifact found for message", async () => {
    const env = createEnv();
    artifactFactory.withArtifactRepository.mockImplementation(
      async (
        _env: Env,
        callback: (repository: ArtifactRepository) => Promise<unknown>,
      ) => await callback(createRepository(undefined)),
    );

    const service = new EditArtifactReviewService(env);
    const source = await service.getReviewSourceByMessage({
      runId: "run-1",
      assistantMessageId: "missing-message",
      userId: "user-1",
    });

    expect(source).toBeNull();
  });
});

async function createStoredArtifact(
  env: Env,
  shaOverride?: string,
): Promise<EditArtifactRecord> {
  const artifact = createArtifact(shaOverride ?? (await sha256Hex(PATCH)));
  await new EditArtifactObjectStore(env.EDIT_ARTIFACTS).writePatch({
    key: artifact.r2ObjectKey,
    patch: PATCH,
    metadata: {
      schemaVersion: 1,
      artifactId: artifact.id,
      userId: artifact.userId,
      runId: artifact.runId,
      sessionId: artifact.sessionId,
      workspaceId: artifact.workspaceId,
      repoOwner: artifact.repoOwner,
      repoName: artifact.repoName,
      branch: artifact.branch,
      baseCommitSha: artifact.baseCommitSha,
      patchSha256: artifact.patchSha256 ?? artifact.sha256 ?? "",
      changedFiles: artifact.changedFiles,
      capturedAt: artifact.createdAt,
    },
  });
  return artifact;
}

function createArtifact(sha256: string): EditArtifactRecord {
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
    sizeBytes: PATCH.length,
    sha256,
    patchSha256: sha256,
    storageBackend: "r2_postgres",
    changedFileCount: 1,
    changedFiles: [
      { path: "src/main.ts", status: "modified", additions: 1, deletions: 1 },
    ],
    status: "stored",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    expiresAt: "2026-06-23T00:00:00.000Z",
  };
}

function createRepository(artifact: EditArtifactRecord): ArtifactRepository {
  return {
    createPendingArtifact: vi.fn(),
    appendEvent: vi.fn(),
    updateStatus: vi.fn(),
    getLatestRestorableArtifact: vi.fn(async () => artifact),
    getLatestRestorableArtifactForRun: vi.fn(async () => artifact),
    getArtifactById: vi.fn(async () => artifact),
    getArtifactByIdForRun: vi.fn(async () => artifact),
    getLatestReviewArtifact: vi.fn(async () => artifact),
    getLatestReviewArtifactForRun: vi.fn(async () => artifact),
    getReviewArtifactByMessage: vi.fn(async () => artifact),
    getReviewArtifactByMessageForRun: vi.fn(async () => artifact),
    updateReviewMetadata: vi.fn(async () => artifact),
    listExpiredArtifacts: vi.fn(async () => []),
    listStalePendingArtifacts: vi.fn(async () => []),
    transaction: vi.fn(),
  } satisfies ArtifactRepository;
}

function createEnv(): Env {
  return { EDIT_ARTIFACTS: new MockR2Bucket() as Env["EDIT_ARTIFACTS"] } as Env;
}

class MockR2Bucket {
  private readonly objects = new Map<string, { text: () => Promise<string> }>();

  async put(key: string, value: string): Promise<{
    key: string;
    etag: string;
    size: number;
  }> {
    this.objects.set(key, { text: async () => value });
    return { key, etag: `etag-${value.length}`, size: value.length };
  }

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
