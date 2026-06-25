import { describe, expect, it } from "vitest";
import { MemoryArtifactRepository } from "./MemoryArtifactRepository.js";

describe("MemoryArtifactRepository", () => {
  it("scopes restorable artifacts by user", async () => {
    const repository = new MemoryArtifactRepository();
    await repository.createPendingArtifact(baseArtifact({ userId: "user-1" }));
    const stored = await repository.updateStatus({
      artifactId: "artifact-1",
      userId: "user-1",
      status: "stored",
      contentType: "text/x-patch",
      sizeBytes: 128,
      sha256: "sha256",
    });

    const owned = await repository.getLatestRestorableArtifact(
      "run-1",
      "user-1",
    );
    const otherUser = await repository.getLatestRestorableArtifact(
      "run-1",
      "user-2",
    );

    expect(stored).toMatchObject({
      contentType: "text/x-patch",
      sizeBytes: 128,
      sha256: "sha256",
    });
    expect(owned?.id).toBe("artifact-1");
    expect(otherUser).toBeNull();
  });

  it("can resolve a restorable artifact by run without an auth user", async () => {
    const repository = new MemoryArtifactRepository();
    await repository.createPendingArtifact(baseArtifact({ userId: "user-1" }));
    await repository.updateStatus({
      artifactId: "artifact-1",
      userId: "user-1",
      status: "stored",
    });

    const artifact =
      await repository.getLatestRestorableArtifactForRun("run-1");

    expect(artifact?.id).toBe("artifact-1");
    expect(artifact?.userId).toBe("user-1");
  });

  it("keeps restored artifacts restorable after a workspace re-clone", async () => {
    const repository = new MemoryArtifactRepository();
    await repository.createPendingArtifact(baseArtifact({ userId: "user-1" }));
    await repository.updateStatus({
      artifactId: "artifact-1",
      userId: "user-1",
      status: "restored",
    });

    const artifact =
      await repository.getLatestRestorableArtifactForRun("run-1");

    expect(artifact?.id).toBe("artifact-1");
    expect(artifact?.status).toBe("restored");
  });

  it("lists all turn patches in capture order for workspace restoration", async () => {
    const repository = new MemoryArtifactRepository();
    await repository.createPendingArtifact(
      baseArtifact({
        id: "artifact-1",
        userId: "user-1",
        captureSequence: 1,
      }),
    );
    await repository.createPendingArtifact(
      baseArtifact({
        id: "artifact-2",
        userId: "user-1",
        captureSequence: 2,
      }),
    );
    await repository.updateStatus({
      artifactId: "artifact-1",
      userId: "user-1",
      status: "stored_with_secondary",
    });
    await repository.updateStatus({
      artifactId: "artifact-2",
      userId: "user-1",
      status: "requires_user_resolution",
    });

    const artifacts = await repository.listRestorableArtifacts({
      runId: "run-1",
      userId: "user-1",
    });

    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-1",
      "artifact-2",
    ]);
  });

  it("returns stale pending artifacts for retention repair", async () => {
    const repository = new MemoryArtifactRepository({
      now: () => new Date("2026-05-10T00:00:00.000Z"),
    });
    await repository.createPendingArtifact(baseArtifact({ userId: "user-1" }));

    const stale = await repository.listStalePendingArtifacts(
      "2026-05-11T00:00:00.000Z",
    );

    expect(stale.map((artifact) => artifact.id)).toEqual(["artifact-1"]);
  });

  it("rolls back writes when a transaction callback fails", async () => {
    const repository = new MemoryArtifactRepository();

    await expect(
      repository.transaction(async (tx) => {
        await tx.createPendingArtifact(baseArtifact({ userId: "user-1" }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    await expect(
      repository.updateStatus({
        artifactId: "artifact-1",
        userId: "user-1",
        status: "stored",
      }),
    ).rejects.toThrow("Artifact not found: artifact-1");
  });
});

function baseArtifact(input: {
  userId: string;
  id?: string;
  captureSequence?: number;
}) {
  const id = input.id ?? "artifact-1";
  return {
    id,
    userId: input.userId,
    runId: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    repoOwner: "owner",
    repoName: "repo",
    repoUrl: "https://github.com/owner/repo",
    branch: "main",
    baseCommitSha: "abc123",
    artifactKind: "git_patch" as const,
    r2ObjectKey: `edit-artifacts/user-1/workspace-1/run-1/${id}/diff.patch`,
    changedFiles: [{ path: "src/main.ts", status: "modified" }],
    captureSequence: input.captureSequence,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}
