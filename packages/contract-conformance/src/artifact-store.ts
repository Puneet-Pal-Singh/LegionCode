import type { ArtifactId } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";

interface ArtifactStoreContract {
  put(input: unknown, access: unknown): Promise<Record<string, unknown>>;
  getMetadata(id: ArtifactId, access: unknown): Promise<Record<string, unknown> | null>;
  getPayload(id: ArtifactId, access: unknown): Promise<Uint8Array | null>;
}

export function registerArtifactStoreConformance(
  implementation: string,
  createStore: (allow: boolean) => unknown,
): void {
  describe(`${implementation} ArtifactStore conformance`, () => {
    it("separates metadata from payload bytes and verifies checksums", async () => {
      const store = createStore(true) as ArtifactStoreContract;
      const metadata = await store.put(createInput("artifact-once"), ACCESS);
      expect(metadata).not.toHaveProperty("content");
      expect(metadata).not.toHaveProperty("payloadBytes");
      expect(metadata.payload).toMatchObject({
        byteSize: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      });
      await expect(store.getPayload(metadata.artifactId as ArtifactId, ACCESS))
        .resolves.toEqual(new TextEncoder().encode("hello"));
    });

    it("enforces authorization before storing metadata or payload", async () => {
      const deniedStore = createStore(false) as ArtifactStoreContract;
      await expect(deniedStore.put(createInput("artifact-denied"), ACCESS))
        .rejects.toMatchObject({ code: "artifact_access_denied" });
    });

    it("treats matching retries as idempotent and rejects changed payloads", async () => {
      const store = createStore(true) as ArtifactStoreContract;
      const first = await store.put(createInput("artifact-retry"), ACCESS);
      const second = await store.put(createInput("artifact-retry"), ACCESS);
      expect(second).toEqual(first);
      await expect(store.put({
        ...createInput("artifact-retry"),
        payload: new TextEncoder().encode("changed"),
      }, ACCESS)).rejects.toMatchObject({ code: "artifact_idempotency_conflict" });
    });
  });
}

const ACCESS = {
  userId: "usr_conformance",
  workspaceId: "wrk_conformance",
  threadId: "thr_conformance",
  runId: "run_conformance",
};

function createInput(idempotencyKey: string): Record<string, unknown> {
  return {
    idempotencyKey,
    kind: "command_log",
    ownership: {
      createdBy: ACCESS.userId,
      workspaceId: ACCESS.workspaceId,
      threadId: ACCESS.threadId,
      runId: ACCESS.runId,
    },
    visibility: "run",
    contentType: "text/plain",
    payload: new TextEncoder().encode("hello"),
  };
}
