import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  RUN_WORKFLOW_STEPS,
  MESSAGE_TRANSCRIPT_PHASES,
  MESSAGE_TRANSCRIPT_STATUSES,
  type RunEvent,
} from "@repo/shared-types";
import {
  isRunEventActivityOpen,
  mergeActivitySnapshots,
  projectRunEventsToActivitySnapshot,
} from "./RunEventActivitySnapshot";

describe("projectRunEventsToActivitySnapshot", () => {
  it("projects live prompt thinking and tool rows before activity polling catches up", () => {
    const snapshot = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: true,
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
        createEvent("event-tool", RUN_EVENT_TYPES.TOOL_REQUESTED, {
          toolId: "tool-1",
          toolName: "read_file",
          arguments: { path: "src/components/layout/Footer.tsx" },
        }),
      ],
    });

    expect(snapshot?.status).toBe("RUNNING");
    expect(snapshot?.items).toHaveLength(3);
    expect(snapshot?.items.map((item) => item.turnId)).toEqual([
      "user-message-1",
      "user-message-1",
      "user-message-1",
    ]);
  });

  it("keeps final assistant text out of the working activity rows", () => {
    const snapshot = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: false,
      events: [
        createEvent("event-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "user",
          content: "Hi",
          metadata: { clientMessageId: "user-message-1" },
        }),
        createEvent("event-final", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "assistant",
          content: "Hello there",
          transcriptPhase: MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER,
          transcriptStatus: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
        }),
        createEvent("event-done", RUN_EVENT_TYPES.RUN_COMPLETED, {
          status: "complete",
          totalDurationMs: 1000,
          toolsUsed: 0,
        }),
      ],
    });

    expect(snapshot?.status).toBe("COMPLETED");
    expect(snapshot?.items).toHaveLength(2);
    expect(snapshot?.items[1]).toMatchObject({
      kind: "commentary",
      phase: "final_answer",
      text: "Hello there",
    });
  });

  it("collapses duplicate live thinking markers for one turn", () => {
    const snapshot = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: true,
      events: [
        createEvent("event-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "user",
          content: "Update footer",
          metadata: { clientMessageId: "user-message-1" },
        }),
        createEvent("event-thinking-1", RUN_EVENT_TYPES.RUN_PROGRESS, {
          phase: RUN_WORKFLOW_STEPS.EXECUTION,
          label: "Thinking",
          summary: "",
          status: "active",
        }),
        createEvent("event-thinking-2", RUN_EVENT_TYPES.RUN_PROGRESS, {
          phase: RUN_WORKFLOW_STEPS.EXECUTION,
          label: "Thinking",
          summary: "",
          status: "active",
        }),
      ],
    });

    expect(snapshot?.items.map((item) => item.id)).toEqual([
      "event-user",
      "event-thinking-2",
    ]);
  });

  it("treats non-terminal canonical events as an open activity run", () => {
    const events = [
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
    ];

    expect(isRunEventActivityOpen({ runId: "run_live", events })).toBe(true);
    expect(
      projectRunEventsToActivitySnapshot({
        runId: "run_live",
        isActive: false,
        events,
      })?.status,
    ).toBe("RUNNING");
  });

  it("lets terminal canonical events settle activity even if local loading is stale", () => {
    const events = [
      createEvent("event-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
        role: "user",
        content: "Hi",
        metadata: { clientMessageId: "user-message-1" },
      }),
      createEvent("event-done", RUN_EVENT_TYPES.RUN_COMPLETED, {
        status: "complete",
        totalDurationMs: 1000,
        toolsUsed: 0,
      }),
    ];

    expect(isRunEventActivityOpen({ runId: "run_live", events })).toBe(false);
    expect(
      projectRunEventsToActivitySnapshot({
        runId: "run_live",
        isActive: true,
        events,
      })?.status,
    ).toBe("COMPLETED");
  });

  it("reopens activity when a later prompt starts after a completed turn", () => {
    const events = [
      createEvent("event-first-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
        role: "user",
        content: "Hi",
        metadata: { clientMessageId: "user-message-1" },
      }),
      createEvent("event-first-done", RUN_EVENT_TYPES.RUN_COMPLETED, {
        status: "complete",
        totalDurationMs: 1000,
        toolsUsed: 0,
      }),
      createEvent(
        "event-second-user",
        RUN_EVENT_TYPES.MESSAGE_EMITTED,
        {
          role: "user",
          content: "Update footer",
          metadata: { clientMessageId: "user-message-2" },
        },
        "2026-06-27T09:00:10.000Z",
      ),
      createEvent(
        "event-second-thinking",
        RUN_EVENT_TYPES.RUN_PROGRESS,
        {
          phase: RUN_WORKFLOW_STEPS.EXECUTION,
          label: "Thinking",
          summary: "",
          status: "active",
        },
        "2026-06-27T09:00:11.000Z",
      ),
    ];

    expect(isRunEventActivityOpen({ runId: "run_live", events })).toBe(true);
    expect(
      projectRunEventsToActivitySnapshot({
        runId: "run_live",
        isActive: false,
        events,
      })?.status,
    ).toBe("RUNNING");
  });
});

describe("mergeActivitySnapshots", () => {
  it("overlays live events onto persisted activity without duplicating matching rows", () => {
    const persisted = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: true,
      events: [
        createEvent("event-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "user",
          content: "Hi",
          metadata: { clientMessageId: "user-message-1" },
        }),
      ],
    });
    const live = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: true,
      events: [
        createEvent("event-user", RUN_EVENT_TYPES.MESSAGE_EMITTED, {
          role: "user",
          content: "Hi",
          metadata: { clientMessageId: "user-message-1" },
        }),
        createEvent("event-thinking", RUN_EVENT_TYPES.RUN_PROGRESS, {
          phase: RUN_WORKFLOW_STEPS.EXECUTION,
          label: "Thinking",
          summary: "",
          status: "active",
        }),
      ],
    });

    const merged = mergeActivitySnapshots(persisted, live);

    expect(merged?.items.map((item) => item.id)).toEqual([
      "event-user",
      "event-thinking",
    ]);
  });

  it("does not let stale live thinking reopen a terminal persisted turn", () => {
    const persisted = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: false,
      events: [
        createEvent(
          "event-user",
          RUN_EVENT_TYPES.MESSAGE_EMITTED,
          {
            role: "user",
            content: "Review hero",
            metadata: { clientMessageId: "user-message-1" },
          },
          "2026-06-27T09:00:00.000Z",
        ),
        createEvent(
          "event-done",
          RUN_EVENT_TYPES.RUN_COMPLETED,
          {
            status: "complete",
            totalDurationMs: 1000,
            toolsUsed: 0,
          },
          "2026-06-27T09:00:02.000Z",
        ),
        createEvent(
          "event-final",
          RUN_EVENT_TYPES.MESSAGE_EMITTED,
          {
            role: "assistant",
            content: "I couldn't prepare the workspace. Bad Gateway",
            transcriptPhase: MESSAGE_TRANSCRIPT_PHASES.FINAL_ANSWER,
            transcriptStatus: MESSAGE_TRANSCRIPT_STATUSES.COMPLETED,
          },
          "2026-06-27T09:00:03.000Z",
        ),
      ],
    });
    const live = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: true,
      events: [
        createEvent(
          "event-user",
          RUN_EVENT_TYPES.MESSAGE_EMITTED,
          {
            role: "user",
            content: "Review hero",
            metadata: { clientMessageId: "user-message-1" },
          },
          "2026-06-27T09:00:00.000Z",
        ),
        createEvent(
          "event-thinking",
          RUN_EVENT_TYPES.RUN_PROGRESS,
          {
            phase: RUN_WORKFLOW_STEPS.EXECUTION,
            label: "Thinking",
            summary: "",
            status: "active",
          },
          "2026-06-27T09:00:01.000Z",
        ),
      ],
    });

    const merged = mergeActivitySnapshots(persisted, live);

    expect(merged?.status).toBe("COMPLETED");
  });

  it("lets newer live activity reopen a terminal persisted turn", () => {
    const persisted = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: false,
      events: [
        createEvent(
          "event-user",
          RUN_EVENT_TYPES.MESSAGE_EMITTED,
          {
            role: "user",
            content: "Review hero",
            metadata: { clientMessageId: "user-message-1" },
          },
          "2026-06-27T09:00:00.000Z",
        ),
        createEvent(
          "event-done",
          RUN_EVENT_TYPES.RUN_COMPLETED,
          {
            status: "complete",
            totalDurationMs: 1000,
            toolsUsed: 0,
          },
          "2026-06-27T09:00:02.000Z",
        ),
      ],
    });
    const live = projectRunEventsToActivitySnapshot({
      runId: "run_live",
      isActive: true,
      events: [
        createEvent(
          "event-second-user",
          RUN_EVENT_TYPES.MESSAGE_EMITTED,
          {
            role: "user",
            content: "Try again",
            metadata: { clientMessageId: "user-message-2" },
          },
          "2026-06-27T09:00:03.000Z",
        ),
        createEvent(
          "event-second-thinking",
          RUN_EVENT_TYPES.RUN_PROGRESS,
          {
            phase: RUN_WORKFLOW_STEPS.EXECUTION,
            label: "Thinking",
            summary: "",
            status: "active",
          },
          "2026-06-27T09:00:04.000Z",
        ),
      ],
    });

    const merged = mergeActivitySnapshots(persisted, live);

    expect(merged?.status).toBe("RUNNING");
  });
});

function createEvent<TType extends RunEvent["type"]>(
  eventId: string,
  type: TType,
  payload: Extract<RunEvent, { type: TType }>["payload"],
  timestamp = `2026-06-27T09:00:0${eventId.length % 10}.000Z`,
): Extract<RunEvent, { type: TType }> {
  return {
    version: 1,
    eventId,
    runId: "run_live",
    sessionId: "session-1",
    timestamp,
    source: "brain",
    type,
    payload,
  } as Extract<RunEvent, { type: TType }>;
}
