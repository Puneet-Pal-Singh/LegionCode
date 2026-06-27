import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import type { ActivityTurnViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import { buildConversationTurns } from "../messageMetadata";
import { buildChatEntries } from "./chatEntries";

describe("buildChatEntries", () => {
  it("anchors runtime-keyed activity turns to the matching prompt", () => {
    const userMessage = createMessage("user-1", "user", "Inspect the repo");
    const assistantMessage = createMessage("assistant-1", "assistant", "Done");
    const activityTurn = createActivityTurn({
      key: "run_123456:turn-1",
      userPrompt: "Inspect the repo",
    });

    const entries = buildChatEntries(
      buildConversationTurns([userMessage, assistantMessage]),
      [activityTurn],
      "run_123456",
    );

    expect(entries).toEqual([
      { kind: "message", message: userMessage },
      { kind: "turn", turn: activityTurn },
      { kind: "message", message: assistantMessage },
    ]);
  });

  it("anchors an unmatched active turn to the latest prompt", () => {
    const firstUser = createMessage("user-1", "user", "First prompt");
    const secondUser = createMessage("user-2", "user", "Second prompt");
    const activeTurn = createActivityTurn({
      key: "run_123456",
      userPrompt: undefined,
      isActiveTurn: true,
    });

    const entries = buildChatEntries(
      buildConversationTurns([firstUser, secondUser]),
      [activeTurn],
      "run_123456",
    );

    expect(entries).toEqual([
      { kind: "message", message: firstUser },
      { kind: "message", message: secondUser },
      { kind: "turn", turn: activeTurn },
    ]);
  });

  it("does not reuse stale prompt matches for repeated prompt text", () => {
    const firstUser = createMessage("user-1", "user", "try again?");
    const firstAssistant = createMessage("assistant-1", "assistant", "First");
    const secondUser = createMessage("user-2", "user", "try again?");
    const secondAssistant = createMessage("assistant-2", "assistant", "Second");
    const firstTurn = createActivityTurn({
      key: "run_123456:turn-1",
      userPrompt: "try again?",
    });
    const secondTurn = createActivityTurn({
      key: "run_123456:turn-2",
      userPrompt: "try again?",
    });

    const entries = buildChatEntries(
      buildConversationTurns([
        firstUser,
        firstAssistant,
        secondUser,
        secondAssistant,
      ]),
      [firstTurn, secondTurn],
      "run_123456",
    );

    expect(entries).toEqual([
      { kind: "message", message: firstUser },
      { kind: "turn", turn: firstTurn },
      { kind: "message", message: firstAssistant },
      { kind: "message", message: secondUser },
      { kind: "turn", turn: secondTurn },
      { kind: "message", message: secondAssistant },
    ]);
  });
});

function createMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date("2026-06-25T00:00:00.000Z"),
  } as Message;
}

function createActivityTurn(
  overrides: Partial<ActivityTurnViewModel>,
): ActivityTurnViewModel {
  return {
    key: "run_123456",
    userPrompt: "Prompt",
    elapsedLabel: "Working for 1s",
    summaryLabel: "Thinking",
    defaultCollapsed: false,
    isActiveTurn: false,
    hasVisibleRows: true,
    rows: [
      {
        kind: "reasoning",
        key: "thinking",
        label: "Thinking",
        summary: "",
        status: "active",
      },
    ],
    ...overrides,
  };
}
