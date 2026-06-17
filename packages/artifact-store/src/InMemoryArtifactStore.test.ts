import { registerArtifactStoreConformance } from "@repo/contract-conformance";
import { ArtifactAccessContextSchema, ArtifactOwnershipSchema } from "./types.js";
import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "./InMemoryArtifactStore.js";
import type { ArtifactAuthorizer } from "./types.js";

registerArtifactStoreConformance("InMemoryArtifactStore", (allow) =>
  new InMemoryArtifactStore({ authorizer: createAuthorizer(allow) }),
);

describe("InMemoryArtifactStore", () => {
  it("rejects an incorrect expected checksum without storing metadata or payload", async () => {
    const store = new InMemoryArtifactStore({ authorizer: createAuthorizer(true) });
    const access = ArtifactAccessContextSchema.parse({
      userId: "usr_checksum",
      workspaceId: "wrk_checksum",
      threadId: "thr_checksum",
      runId: "run_checksum",
    });
    await expect(store.put({
      idempotencyKey: "checksum-mismatch",
      kind: "command_log",
      ownership: ArtifactOwnershipSchema.parse({
        createdBy: "usr_checksum",
        workspaceId: "wrk_checksum",
        threadId: "thr_checksum",
        runId: "run_checksum",
      }),
      visibility: "run",
      contentType: "text/plain",
      payload: new TextEncoder().encode("hello"),
      expectedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }, access)).rejects.toMatchObject({ code: "artifact_checksum_mismatch" });

    await expect(store.list(access)).resolves.toEqual([]);
  });

  it("rejects ownership claims outside the caller access scope", async () => {
    const store = new InMemoryArtifactStore({ authorizer: createAuthorizer(true) });
    const access = ArtifactAccessContextSchema.parse({
      userId: "usr_caller1",
      workspaceId: "wrk_caller1",
      threadId: "thr_caller1",
      runId: "run_caller1",
    });

    await expect(store.put({
      idempotencyKey: "ownership-mismatch",
      kind: "command_log",
      ownership: ArtifactOwnershipSchema.parse({
        createdBy: "usr_other12",
        workspaceId: "wrk_caller1",
        threadId: "thr_caller1",
        runId: "run_caller1",
      }),
      visibility: "run",
      contentType: "text/plain",
      payload: new TextEncoder().encode("secret"),
    }, access)).rejects.toMatchObject({ code: "artifact_access_denied" });
  });
});

function createAuthorizer(allow: boolean): ArtifactAuthorizer {
  return { authorize: async () => allow };
}
