import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import type {
  ActivityFeedSnapshot,
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

  it("keeps a completed duration header when a turn only has hidden activity", () => {
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

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      elapsedLabel: "Worked for 1s",
      hasVisibleRows: true,
      rows: [],
    });
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
    expect(turns[0]?.elapsedLabel).toBe("Worked for 1s");
  });

  it("prefers canonical activity snapshots over lossy transcript events", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "inspect the project"),
      createAssistantMessageWithActivity({
        ...createPart("user-1", [createToolEvent()]),
        activitySnapshot: createCanonicalActivitySnapshot(),
      }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      key: "user-1",
      userPrompt: "inspect the project",
      summaryLabel: "2 tool calls",
    });
    expect(turns[0]?.rows).toEqual([
      expect.objectContaining({
        kind: "group",
        title: "Explored",
        rows: [
          expect.objectContaining({
            kind: "tool",
            family: "read",
            title: "Reading package.json",
          }),
          expect.objectContaining({
            kind: "tool",
            family: "search",
            title: "Searching source",
          }),
        ],
      }),
    ]);
  });

  it("preserves workflow thinking and deduplicates progress rows", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "say hello"),
      createAssistantMessageWithActivity(
        createPart("turn-1", [
          createProgressEvent({
            id: "execution-state",
            sequence: 1,
            kind: "thinking",
            title: "Working through execution",
          }),
          createProgressEvent({
            id: "progress-1",
            sequence: 2,
            title: "Inspecting repository",
            detail: "Inspecting repository",
          }),
          createProgressEvent({
            id: "progress-2",
            sequence: 3,
            title: "Inspecting repository",
            detail: "Inspecting repository",
          }),
          createProgressEvent({
            id: "synthesis-state",
            sequence: 4,
            kind: "thinking",
            title: "Working through synthesis",
            updatedAt: "2026-05-24T00:00:06.000Z",
          }),
        ]),
      ),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.elapsedLabel).toBe("Worked for 6s");
    expect(turns[0]?.rows).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        label: "Working through execution",
      }),
      expect.objectContaining({
        kind: "reasoning",
        label: "Inspecting repository",
        summary: "",
      }),
      expect.objectContaining({
        kind: "reasoning",
        label: "Working through synthesis",
      }),
    ]);
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

function createCanonicalActivitySnapshot(): ActivityFeedSnapshot {
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "COMPLETED",
    items: [
      {
        id: "user-event",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "user-1",
        kind: "text",
        role: "user",
        content: "inspect the project",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
        source: "brain",
      },
      {
        id: "read-tool",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "user-1",
        kind: "tool",
        toolId: "tool-read",
        toolName: "read_file",
        status: "completed",
        input: { path: "package.json" },
        metadata: {
          family: "read",
          displayText: "Reading package.json",
          path: "package.json",
          count: 1,
          truncated: false,
          loadedPaths: ["package.json"],
        },
        createdAt: "2026-05-24T00:00:01.000Z",
        updatedAt: "2026-05-24T00:00:02.000Z",
        source: "brain",
      },
      {
        id: "search-tool",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "user-1",
        kind: "tool",
        toolId: "tool-search",
        toolName: "search_code",
        status: "completed",
        input: { pattern: "README" },
        metadata: {
          family: "search",
          displayText: "Searching source",
          pattern: "README",
          count: 2,
          truncated: false,
          loadedPaths: ["README.md"],
        },
        createdAt: "2026-05-24T00:00:03.000Z",
        updatedAt: "2026-05-24T00:00:04.000Z",
        source: "brain",
      },
    ],
  };
}
