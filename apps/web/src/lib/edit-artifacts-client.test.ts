import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/sdk";
import { getEditArtifactReviewSourceByMessage } from "../services/api/artifactReads.js";

describe("getEditArtifactReviewSourceByMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an artifact owned by a different assistant message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: "artifact/reviewByMessage",
          ok: true,
          result: {
            source: {
              kind: "prompt_artifact",
              artifactId: "artifact-b",
              runId: "run-1",
              sessionId: "session-1",
              workspaceId: "workspace-1",
              threadId: "thread-1",
              turnId: "turn-1",
              runAttemptId: "attempt-1",
              assistantMessageId: "message-b",
              status: "stored",
              files: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              storageBackend: "r2_postgres",
            },
            status: 200,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const source = await getEditArtifactReviewSourceByMessage({
      runId: "run-1",
      assistantMessageId: "message-a",
      identity: {
        threadId: "thread-1",
        turnId: "turn-1",
        runAttemptId: "attempt-1",
        workspaceId: "workspace-1",
      },
    });

    expect(source).toBeNull();
  });
});
