import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import type {
  TurnActivityEvent,
  TurnActivityTranscriptPart,
} from "@repo/shared-types";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "./TranscriptActivityParts.js";
import type { ActivityTurnViewModel } from "./ActivityFeedViewModel.js";

describe("TranscriptActivityParts", () => {
  it("keeps provider retry debug events out of visible transcript rows", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "check CI"),
      createAssistantMessageWithActivity(
        createPart("run-1:turn-1", [
          createProgressEvent({
            id: "retry-1",
            sequence: 1,
            displayMode: "debug",
            title: "Retrying model request",
            detail: "Retrying once before pausing the run.",
            metadata: {
              code: "MODEL_UNUSABLE_RESPONSE",
              retryCount: 1,
            },
          }),
          createProviderErrorEvent(),
        ]),
      ),
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

  it("drops turns that only contain debug activity", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "check CI"),
      createAssistantMessageWithActivity(
        createPart("run-1:turn-1", [
          createProgressEvent({
            id: "retry-1",
            sequence: 1,
            displayMode: "debug",
            title: "Retrying model request",
          }),
        ]),
      ),
    ]);

    expect(turns).toEqual([]);
  });

  it("builds transcript turns with the latest preceding user prompt", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "first prompt"),
      createMessage("assistant", "first answer"),
      createMessage("user", "resume the failed task"),
      createAssistantMessageWithActivity(
        createPart("turn-1", [createToolEvent()]),
      ),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.userPrompt).toBe("resume the failed task");
    expect(turns[0]?.rows[0]).toMatchObject({
      kind: "tool",
      title: "Inspecting checks",
    });
  });

  it("keeps transcript rows when the matching live turn is less complete", () => {
    const transcriptTurn = createActivityTurn("turn-1", {
      rows: [
        {
          kind: "tool",
          key: "tool-complete",
          toolName: "gh",
          family: "generic",
          title: "Inspecting checks",
          summary: "checks complete",
          status: "completed",
          defaultCollapsed: false,
          details: [],
        },
        {
          kind: "commentary",
          key: "provider-error",
          phase: "commentary",
          status: "completed",
          text: "Provider interruption",
          metadata: { code: "PROVIDER_UNAVAILABLE" },
        },
      ],
    });
    const liveTurn = createActivityTurn("turn-1", {
      rows: [
        {
          kind: "tool",
          key: "tool-running",
          toolName: "gh",
          family: "generic",
          title: "Inspecting checks",
          summary: "still running",
          status: "running",
          defaultCollapsed: false,
          details: [],
        },
      ],
    });

    const merged = mergeTranscriptAndLiveActivityTurns(
      [transcriptTurn],
      [liveTurn],
    );

    expect(merged).toEqual([transcriptTurn]);
  });
});

function createMessage(role: Message["role"], content: string): Message {
  return {
    id: `${role}-${content}`,
    role,
    content,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
  } as Message;
}

function createAssistantMessageWithActivity(
  part: TurnActivityTranscriptPart,
): Message {
  return {
    ...createMessage("assistant", ""),
    data: { activityParts: [part] },
  } as unknown as Message;
}

function createPart(
  turnId: string,
  events: TurnActivityEvent[],
): TurnActivityTranscriptPart {
  return {
    version: 1,
    type: "turn_activity",
    events: events.map((event) => ({ ...event, turnId })),
    compacted: false,
  };
}

function createProgressEvent(
  overrides: Partial<TurnActivityEvent>,
): TurnActivityEvent {
  return {
    id: "progress-1",
    runId: "run-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 1,
    kind: "progress",
    status: "completed",
    title: "Progress",
    displayMode: "visible",
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function createProviderErrorEvent(): TurnActivityEvent {
  return {
    id: "provider-error-1",
    runId: "run-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 2,
    kind: "provider_error",
    status: "paused",
    title: "Provider interruption",
    detail: "The selected model stopped responding after retrying.",
    displayMode: "visible",
    metadata: {
      code: "PROVIDER_UNAVAILABLE",
    },
    createdAt: "2026-05-24T00:00:01.000Z",
    updatedAt: "2026-05-24T00:00:01.000Z",
  };
}

function createToolEvent(): TurnActivityEvent {
  return {
    id: "tool-1",
    runId: "run-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 1,
    kind: "tool_call",
    status: "completed",
    title: "Inspecting checks",
    displayMode: "visible",
    metadata: { toolName: "gh" },
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:01.000Z",
  };
}

function createActivityTurn(
  key: string,
  overrides: Partial<ActivityTurnViewModel>,
): ActivityTurnViewModel {
  return {
    key,
    userPrompt: "prompt",
    elapsedLabel: "Just now",
    summaryLabel: "1 activity row",
    defaultCollapsed: false,
    isActiveTurn: false,
    hasVisibleRows: true,
    rows: [],
    ...overrides,
  };
}
