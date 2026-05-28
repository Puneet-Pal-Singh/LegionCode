import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { buildTranscriptActivityTurns } from "./TranscriptActivityParts.js";

describe("TranscriptActivityParts", () => {
  it("keeps provider retry debug events out of visible transcript rows", () => {
    const turns = buildTranscriptActivityTurns([
      {
        id: "user-1",
        role: "user",
        content: "check CI",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "The selected model stopped responding.",
        data: {
          activityParts: [
            {
              version: 1,
              type: "turn_activity",
              compacted: false,
              events: [
                {
                  id: "retry-1",
                  runId: "run-1",
                  sessionId: "session-1",
                  turnId: "run-1:turn-1",
                  sequence: 1,
                  kind: "progress",
                  status: "completed",
                  title: "Retrying model request",
                  detail: "Retrying once before pausing the run.",
                  displayMode: "debug",
                  metadata: {
                    code: "MODEL_UNUSABLE_RESPONSE",
                    retryCount: 1,
                  },
                  createdAt: "2026-05-24T00:00:00.000Z",
                  updatedAt: "2026-05-24T00:00:00.000Z",
                },
                {
                  id: "provider-error-1",
                  runId: "run-1",
                  sessionId: "session-1",
                  turnId: "run-1:turn-1",
                  sequence: 2,
                  kind: "provider_error",
                  status: "paused",
                  title: "Provider interruption",
                  detail:
                    "The selected model stopped responding after retrying.",
                  displayMode: "visible",
                  metadata: {
                    code: "PROVIDER_UNAVAILABLE",
                  },
                  createdAt: "2026-05-24T00:00:01.000Z",
                  updatedAt: "2026-05-24T00:00:01.000Z",
                },
              ],
            },
          ],
        },
      } as Message,
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.rows).toHaveLength(1);
    expect(turns[0]?.summaryLabel).toBe("Paused after provider interruption");
    expect(turns[0]?.rows[0]).toMatchObject({
      kind: "commentary",
      metadata: {
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });
});
