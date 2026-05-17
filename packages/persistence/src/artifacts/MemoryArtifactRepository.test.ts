import { describe, expect, it } from "vitest";
import { MemoryArtifactRepository } from "./MemoryArtifactRepository.js";

describe("MemoryArtifactRepository", () => {
  it("scopes restorable artifacts by user", async () => {
    const repository = new MemoryArtifactRepository();
    await repository.createPendingArtifact(baseArtifact({ userId: "user-1" }));
    const stored = await repository.updateStatus({
      artifactId: "artifact-1",
      status: "stored",
      contentType: "text/x-patch",
      sizeBytes: 128,
      sha256: "sha256",
    });

    const owned = await repository.getLatestRestorableArtifact("run-1", "user-1");
    const otherUser = await repository.getLatestRestorableArtifact("run-1", "user-2");

    expect(stored).toMatchObject({
      contentType: "text/x-patch",
      sizeBytes: 128,
      sha256: "sha256",
    });
    expect(owned?.id).toBe("artifact-1");
    expect(otherUser).toBeNull();
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
});

function baseArtifact(input: { userId: string }) {
  return {
    id: "artifact-1",
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
    r2ObjectKey: "edit-artifacts/user-1/workspace-1/run-1/artifact-1/diff.patch",
    changedFiles: [{ path: "src/main.ts", status: "modified" }],
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}
