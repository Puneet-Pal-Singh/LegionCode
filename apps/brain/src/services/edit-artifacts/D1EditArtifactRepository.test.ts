import { beforeEach, describe, expect, it } from "vitest";
import { D1EditArtifactRepository } from "./D1EditArtifactRepository";
import { MockEditArtifactD1 } from "./D1EditArtifactRepository.test-helpers";

describe("D1EditArtifactRepository", () => {
  let db: MockEditArtifactD1;
  let repository: D1EditArtifactRepository;

  beforeEach(() => {
    db = new MockEditArtifactD1();
    repository = new D1EditArtifactRepository(db.asD1());
  });

  it("creates pending artifact metadata and appends capture events", async () => {
    const artifact = await repository.createPendingArtifact({
      id: "artifact-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repoOwner: "owner",
      repoName: "repo",
      repoUrl: "https://github.com/owner/repo",
      branch: "main",
      baseCommitSha: "abc123",
      artifactKind: "git_patch",
      r2ObjectKey: "edit-artifacts/workspace-1/run-1/artifact-1/diff.patch",
      changedFiles: [{ path: "src/main.ts", status: "modified" }],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const event = await repository.appendEvent({
      id: "event-1",
      artifactId: artifact.id,
      runId: artifact.runId,
      eventType: "capture_started",
      message: "Capture started",
      metadata: { r2ObjectKey: artifact.r2ObjectKey },
    });

    expect(artifact.status).toBe("pending");
    expect(artifact.changedFileCount).toBe(1);
    expect(event.eventType).toBe("capture_started");
    expect(db.events).toHaveLength(1);
  });

  it("returns latest non-expired restorable artifact", async () => {
    await repository.createPendingArtifact({
      id: "artifact-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repoOwner: null,
      repoName: null,
      repoUrl: null,
      branch: "main",
      baseCommitSha: null,
      artifactKind: "git_patch",
      r2ObjectKey: "key-1",
      changedFiles: [{ path: "a.ts", status: "modified" }],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    await repository.updateStatus({
      artifactId: "artifact-1",
      status: "stored",
    });

    const latest = await repository.getLatestRestorableArtifact("run-1");

    expect(latest?.id).toBe("artifact-1");
    expect(latest?.status).toBe("stored");
  });

  it("returns stale pending artifacts for retention repair", async () => {
    await repository.createPendingArtifact({
      id: "artifact-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repoOwner: null,
      repoName: null,
      repoUrl: null,
      branch: "main",
      baseCommitSha: null,
      artifactKind: "git_patch",
      r2ObjectKey: "key-1",
      changedFiles: [{ path: "a.ts", status: "modified" }],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    await repository.createPendingArtifact({
      id: "artifact-2",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repoOwner: null,
      repoName: null,
      repoUrl: null,
      branch: "main",
      baseCommitSha: null,
      artifactKind: "git_patch",
      r2ObjectKey: "key-2",
      changedFiles: [{ path: "b.ts", status: "modified" }],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const staleArtifact = db.artifacts.get("artifact-1");
    const freshArtifact = db.artifacts.get("artifact-2");
    expect(staleArtifact).toBeDefined();
    expect(freshArtifact).toBeDefined();
    staleArtifact!.created_at = "2026-05-10T00:00:00.000Z";
    freshArtifact!.created_at = "2026-05-12T00:00:00.000Z";

    const stale = await repository.listStalePendingArtifacts(
      "2026-05-11T00:00:00.000Z",
    );

    expect(stale.map((artifact) => artifact.id)).toEqual(["artifact-1"]);
  });
});
