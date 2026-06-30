import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import type {
  ActivityFeedSnapshot,
  TurnActivityTranscriptPart,
} from "@repo/shared-types";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "./TranscriptActivityParts.js";
import type { ActivityTurnViewModel } from "./ActivityFeedViewModel.js";

describe("TranscriptActivityParts", () => {
  it("hydrates transcript turns from canonical activity snapshots", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "inspect the project"),
      createAssistantMessageWithActivity(
        createActivityPart(createCanonicalActivitySnapshot()),
      ),
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

  it("does not replay legacy event-only activity parts", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "check CI"),
      createAssistantMessageWithRawActivityParts([
        {
          version: 1,
          type: "turn_activity",
          events: [
            {
              id: "legacy-tool",
              runId: "run-1",
              sessionId: "session-1",
              turnId: "user-1",
              sequence: 1,
              kind: "tool_call",
              status: "completed",
              title: "Inspecting checks",
              displayMode: "visible",
              createdAt: "2026-05-24T00:00:00.000Z",
              updatedAt: "2026-05-24T00:00:01.000Z",
            },
          ],
          compacted: false,
        },
      ]),
    ]);

    expect(turns).toEqual([]);
  });

  it("preserves provider interruption rows from canonical snapshots", () => {
    const turns = buildTranscriptActivityTurns([
      createMessage("user", "check CI"),
      createAssistantMessageWithActivity(
        createActivityPart(createProviderInterruptionSnapshot()),
      ),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      key: "user-1",
      summaryLabel: "Paused after provider interruption",
    });
    expect(turns[0]?.rows).toEqual([
      expect.objectContaining({
        kind: "commentary",
        metadata: {
          code: "PROVIDER_UNAVAILABLE",
        },
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

  it("prefers active live canonical activity over settled transcript rows", () => {
    const transcriptTurn = createActivityTurn("turn-1", {
      rows: [
        {
          kind: "tool",
          key: "tool-complete",
          toolName: "read_file",
          family: "read",
          title: "Reading Footer.tsx",
          summary: "Read complete",
          status: "completed",
          defaultCollapsed: false,
          details: [],
        },
      ],
    });
    const liveTurn = createActivityTurn("turn-1", {
      isActiveTurn: true,
      rows: [
        {
          kind: "reasoning",
          key: "thinking-live",
          label: "Thinking",
          summary: "",
          status: "active",
        },
      ],
    });

    const merged = mergeTranscriptAndLiveActivityTurns(
      [transcriptTurn],
      [liveTurn],
    );

    expect(merged).toEqual([liveTurn]);
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
  return createAssistantMessageWithRawActivityParts([part]);
}

function createAssistantMessageWithRawActivityParts(
  activityParts: unknown[],
): Message {
  return {
    ...createMessage("assistant", ""),
    data: { activityParts },
  } as unknown as Message;
}

function createActivityPart(
  activitySnapshot: ActivityFeedSnapshot,
): TurnActivityTranscriptPart {
  return {
    version: 1,
    type: "turn_activity",
    events: [],
    activitySnapshot,
    compacted: false,
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

function createProviderInterruptionSnapshot(): ActivityFeedSnapshot {
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "PAUSED",
    items: [
      {
        id: "user-event",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "user-1",
        kind: "text",
        role: "user",
        content: "check CI",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
        source: "brain",
      },
      {
        id: "provider-error",
        runId: "run-1",
        sessionId: "session-1",
        turnId: "user-1",
        kind: "commentary",
        phase: "commentary",
        status: "completed",
        text: "The selected model stopped responding after retrying.",
        metadata: {
          code: "PROVIDER_UNAVAILABLE",
        },
        createdAt: "2026-05-24T00:00:01.000Z",
        updatedAt: "2026-05-24T00:00:01.000Z",
        source: "brain",
      },
    ],
  };
}
