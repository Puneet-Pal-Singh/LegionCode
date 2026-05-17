import { describe, expect, it } from "vitest";
import type { EditArtifactPatchObjectMetadata } from "@repo/shared-types";
import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";

describe("EditArtifactObjectStore", () => {
  it("builds canonical user-owned edit artifact keys", () => {
    const store = new EditArtifactObjectStore(new MockR2Bucket() as R2Bucket);

    expect(
      store.buildPatchKey({
        userId: "user 1",
        workspaceId: "workspace 1",
        runId: "run/1",
        artifactId: "artifact#1",
      }),
    ).toBe("edit-artifacts/user%201/workspace%201/run%2F1/artifact%231/diff.patch");
  });

  it("rejects old pre-user-owned edit artifact keys", async () => {
    const store = new EditArtifactObjectStore(new MockR2Bucket() as R2Bucket);

    await expect(
      store.readPatch("edit-artifacts/workspace-1/run-1/artifact-1/diff.patch"),
    ).rejects.toThrow("Invalid edit artifact key scope");
  });

  it("writes and reads patches with ownership metadata", async () => {
    const store = new EditArtifactObjectStore(new MockR2Bucket() as R2Bucket);
    const metadata = buildMetadata();
    const key = store.buildPatchKey({
      userId: metadata.userId,
      workspaceId: metadata.workspaceId,
      runId: metadata.runId,
      artifactId: metadata.artifactId,
    });

    await store.writePatch({ key, patch: "diff --git", metadata });

    await expect(store.readPatch(key)).resolves.toBe("diff --git");
  });
});

class MockR2Bucket {
  private readonly objects = new Map<string, MockR2Object>();

  async put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<MockR2Object> {
    const object = new MockR2Object(key, value, options?.customMetadata);
    this.objects.set(key, object);
    return object;
  }

  async get(key: string): Promise<MockR2Object | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class MockR2Object implements Partial<R2Object> {
  readonly etag: string;
  readonly size: number;

  constructor(
    readonly key: string,
    private readonly value: string,
    readonly customMetadata?: Record<string, string>,
  ) {
    this.size = value.length;
    this.etag = `etag-${value.length}`;
  }

  async text(): Promise<string> {
    return this.value;
  }
}

function buildMetadata(): EditArtifactPatchObjectMetadata {
  return {
    schemaVersion: 1,
    artifactId: "artifact-1",
    userId: "user-1",
    runId: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    repoOwner: "owner",
    repoName: "repo",
    branch: "main",
    baseCommitSha: "abc123",
    patchSha256: "sha256",
    changedFiles: [{ path: "src/main.ts", status: "modified" }],
    capturedAt: "2026-05-10T00:00:00.000Z",
  };
}
