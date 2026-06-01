import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES, type RunEvent } from "@repo/shared-types";
import { projectRunActivityTranscript } from "./RunActivityTranscriptProjector.js";

describe("RunActivityTranscriptProjector", () => {
  it("persists provider interruption and finalizes unfinished tool activity", () => {
    const part = projectRunActivityTranscript({
      runId: "run-1",
      sessionId: "session-1",
      terminalStatus: "paused",
      terminalReason: "Provider stopped responding",
      events: [
        createEvent("event-1", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "user",
          content: "check CI",
        }),
        createEvent("event-2", RUN_EVENT_TYPES.RUN_PROGRESS, {
          phase: "execution",
          label: "Checking CI",
          summary: "Reading current check status.",
          status: "active",
        }),
        createEvent("event-3", RUN_EVENT_TYPES.TOOL_REQUESTED, {
          toolId: "tool-1",
          toolName: "gh",
          arguments: { command: "gh pr checks" },
          displayText: "Inspecting PR checks",
        }),
        createEvent("event-4", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "assistant",
          content: "The selected model stopped responding.",
          metadata: {
            code: "PROVIDER_UNAVAILABLE",
            retryable: true,
            providerId: "google",
            modelId: "gemma-4-31b-it",
            statusCode: 500,
            retryCount: 3,
          },
        }),
      ],
    });

    expect(part).toMatchObject({
      version: 1,
      type: "turn_activity",
      compacted: false,
    });
    expect(part.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(part.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "progress",
          status: "paused",
          title: "Checking CI",
        }),
        expect.objectContaining({
          kind: "tool_call",
          status: "paused",
          title: "Inspecting PR checks",
        }),
        expect.objectContaining({
          kind: "provider_error",
          status: "paused",
          title: "Provider interruption",
          metadata: expect.objectContaining({
            code: "PROVIDER_UNAVAILABLE",
            statusCode: 500,
          }),
        }),
      ]),
    );
  });
});

function createEvent(
  eventId: string,
  type: RunEvent["type"],
  payload: RunEvent["payload"],
): RunEvent {
  return {
    version: 1,
    eventId,
    runId: "run-1",
    sessionId: "session-1",
    timestamp: `2026-05-24T00:00:0${eventId.slice(-1)}.000Z`,
    source: "brain",
    type,
    payload,
  } as RunEvent;
}
