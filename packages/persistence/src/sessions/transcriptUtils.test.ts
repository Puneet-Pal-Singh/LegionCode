import { describe, expect, it } from "vitest";

import { firstSequence, lastSequence } from "./transcriptUtils.js";
import type { TranscriptMessageRecord } from "./types.js";

describe("transcriptUtils", () => {
  it("returns safe sequence defaults for messages without parts", () => {
    const message = createMessage([]);

    expect(firstSequence(message)).toBe(0);
    expect(lastSequence(message)).toBe(0);
  });

  it("reads first and last session sequences from message parts", () => {
    const message = createMessage([3, 1, 2]);

    expect(firstSequence(message)).toBe(1);
    expect(lastSequence(message)).toBe(3);
  });
});

function createMessage(sequences: number[]): TranscriptMessageRecord {
  return {
    id: "message-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "assistant",
    clientMessageId: null,
    createdAt: "2026-05-16T00:00:00.000Z",
    parts: sequences.map((sessionSequence) => ({
      id: `part-${sessionSequence}`,
      messageId: "message-1",
      sessionId: "session-1",
      runId: "run-1",
      type: "text",
      sessionSequence,
      content: { text: String(sessionSequence) },
      createdAt: "2026-05-16T00:00:00.000Z",
    })),
  };
}
