import { renderHook } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import {
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  type RunEvent,
} from "@repo/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActivityPresentation } from "./useActivityPresentation";

describe("useActivityPresentation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not create local thinking rows without canonical run events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T09:00:05.000Z"));
    const { result } = renderHook(() =>
      useActivityPresentation({
        runId: "run_live",
        messages: [createUserMessage("user-message-1", "Update footer")],
        feed: null,
        events: [],
        isLoading: true,
      }),
    );

    expect(result.current.viewModel.turns).toEqual([]);
  });

  it("projects active thinking and elapsed time from canonical event timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T09:00:05.000Z"));
    const { result } = renderHook(() =>
      useActivityPresentation({
        runId: "run_live",
        messages: [createUserMessage("user-message-1", "Update footer")],
        feed: null,
        events: [
          createEvent("event-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
            role: "user",
            content: "Update footer",
            metadata: { clientMessageId: "user-message-1" },
          }),
          createEvent("event-thinking", RUN_EVENT_TYPES.RUN_PROGRESS, {
            phase: RUN_WORKFLOW_STEPS.EXECUTION,
            label: "Thinking",
            summary: "",
            status: "active",
          }),
        ],
        isLoading: true,
      }),
    );

    expect(result.current.viewModel.turns).toHaveLength(1);
    expect(result.current.viewModel.turns[0]).toMatchObject({
      key: "user-message-1",
      userPrompt: "Update footer",
      elapsedLabel: "Working for 5s",
      isActiveTurn: true,
      rows: [
        {
          kind: "reasoning",
          label: "Thinking",
          status: "active",
        },
      ],
    });
  });
});

function createUserMessage(id: string, content: string): Message {
  return {
    id,
    role: "user",
    content,
  };
}

function createEvent<TType extends RunEvent["type"]>(
  eventId: string,
  type: TType,
  payload: Extract<RunEvent, { type: TType }>["payload"],
): Extract<RunEvent, { type: TType }> {
  return {
    version: 1,
    eventId,
    runId: "run_live",
    sessionId: "session-1",
    timestamp:
      eventId === "event-user"
        ? "2026-06-27T09:00:00.000Z"
        : "2026-06-27T09:00:01.000Z",
    source: "brain",
    type,
    payload,
  } as Extract<RunEvent, { type: TType }>;
}
