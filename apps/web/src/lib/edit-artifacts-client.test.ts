import { afterEach, describe, expect, it, vi } from "vitest";
import { getEditArtifactReviewSourceByMessage } from "./edit-artifacts-client.js";

describe("getEditArtifactReviewSourceByMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an artifact owned by a different assistant message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "prompt_artifact",
          artifactId: "artifact-b",
          runId: "run-1",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          assistantMessageId: "message-b",
          status: "stored",
          files: [],
          createdAt: "2026-06-21T00:00:00.000Z",
          storageBackend: "r2_postgres",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const source = await getEditArtifactReviewSourceByMessage({
      runId: "run-1",
      assistantMessageId: "message-a",
    });

    expect(source).toBeNull();
  });
});
