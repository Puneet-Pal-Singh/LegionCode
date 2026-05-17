import { beforeEach, describe, expect, it } from "vitest";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import type { EditArtifactPatchObjectMetadata } from "@repo/shared-types";

interface MockObject {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
  text(): Promise<string>;
}

class MockR2Bucket {
  private objects = new Map<
    string,
    { value: string; customMetadata?: Record<string, string> }
  >();

  async head(key: string): Promise<MockObject | null> {
    return this.getObject(key);
  }

  async get(key: string): Promise<MockObject | null> {
    return this.getObject(key);
  }

  async put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<MockObject> {
    this.objects.set(key, {
      value,
      customMetadata: options?.customMetadata,
    });
    return this.buildObject(key, value, options?.customMetadata);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  private getObject(key: string): MockObject | null {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }

    return this.buildObject(key, object.value, object.customMetadata);
  }

  private buildObject(
    key: string,
    value: string,
    customMetadata?: Record<string, string>,
  ): MockObject {
    return {
      key,
      size: value.length,
      etag: `etag-${value.length}`,
      uploaded: new Date("2026-05-10T00:00:00.000Z"),
      customMetadata,
      text: async () => value,
    };
  }
}

const metadata: EditArtifactPatchObjectMetadata = {
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

describe("EditArtifactObjectStore", () => {
  let store: EditArtifactObjectStore;

  beforeEach(() => {
    store = new EditArtifactObjectStore(new MockR2Bucket());
  });

  it("builds deterministic escaped patch keys", () => {
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
    await expect(
      store.readPatch("edit-artifacts/workspace-1/run-1/artifact-1/diff.patch"),
    ).rejects.toThrow("Invalid edit artifact key scope");
  });

  it("writes, reads, and exposes patch metadata", async () => {
    const key = store.buildPatchKey({
      userId: metadata.userId,
      workspaceId: metadata.workspaceId,
      runId: metadata.runId,
      artifactId: metadata.artifactId,
    });

    const stored = await store.writePatch({
      key,
      patch: "diff --git a/src/main.ts b/src/main.ts",
      metadata,
    });
    const patch = await store.readPatch(key);
    const storedMetadata = await store.getPatchMetadata(key);

    expect(stored.key).toBe(key);
    expect(patch).toContain("diff --git");
    expect(storedMetadata?.metadata).toEqual(metadata);
  });
});
