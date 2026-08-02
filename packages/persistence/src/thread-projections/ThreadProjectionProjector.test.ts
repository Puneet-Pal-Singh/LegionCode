import {
  EVENT_SCHEMA_VERSION,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
  type PlatformEvent,
  type ThreadId,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { projectThreadEvents } from "./ThreadProjectionProjector.js";
import { ThreadProjectionError } from "./types.js";

const timestamp = "2026-06-09T12:00:00.000Z";
const threadId = "thr_abc123" as ThreadId;

describe("ThreadProjectionProjector", () => {
  it("rebuilds thread state from title pin and archive events", () => {
    const snapshot = projectThreadEvents(threadId, [
      projectionInput(createThreadEvent("thread.created", thread, 1), 1),
      projectionInput(
        createTitleEvent("Renamed thread", "user", 2),
        2,
      ),
      projectionInput(
        createThreadEvent(
          "thread.pinned",
          {
            ...thread,
            title: "Renamed thread",
            titleSource: "user",
            pinnedAt: "2026-06-09T12:02:00.000Z",
            updatedAt: "2026-06-09T12:02:00.000Z",
          },
          3,
        ),
        3,
      ),
      projectionInput(
        createThreadEvent(
          "thread.archived",
          {
            ...thread,
            title: "Renamed thread",
            titleSource: "user",
            status: "archived",
            pinnedAt: "2026-06-09T12:02:00.000Z",
            archivedAt: "2026-06-09T12:03:00.000Z",
            updatedAt: "2026-06-09T12:03:00.000Z",
          },
          4,
        ),
        4,
      ),
    ]);

    expect(snapshot?.thread).toMatchObject({
      title: "Renamed thread",
      titleSource: "user",
      status: "archived",
      pinnedAt: "2026-06-09T12:02:00.000Z",
      archivedAt: "2026-06-09T12:03:00.000Z",
      lastEventSequence: 4,
    });
    expect(snapshot?.lastCursor).toBe("cursor_000004");
  });

  it("includes old user and assistant message items in replay order", () => {
    const snapshot = projectThreadEvents(threadId, [
      projectionInput(createThreadEvent("thread.created", thread, 1), 1),
      projectionInput(createItemEvent("item.completed", userItem, 2), 2),
      projectionInput(createItemEvent("item.completed", assistantItem, 3), 3),
    ]);

    expect(snapshot?.items.map((item) => item.id)).toEqual([
      "itm_user001",
      "itm_asst001",
    ]);
    expect(snapshot?.thread.activeLeafItemId).toBe("itm_asst001");
    expect(snapshot?.thread.activeRunId).toBe("run_abc123");
    expect(snapshot?.thread.lastEventSequence).toBe(3);
  });

  it("marks only the first completed turn as title-eligible while retaining later terminal unread state", () => {
    const snapshot = projectThreadEvents(threadId, [
      projectionInput(createThreadEvent("thread.created", thread, 1), 1),
      projectionInput(createTurnEvent("turn.completed", firstTurn, 2), 2),
      projectionInput(
        createTitleEvent("Durable title", "generated", 3),
        3,
      ),
      projectionInput(createTurnEvent("turn.completed", secondTurn, 4), 4),
    ]);

    expect(snapshot?.thread).toMatchObject({
      title: "Durable title",
      titleVersion: 2,
      titleStatus: "ready",
      lastTerminalTurnId: secondTurn.id,
    });
  });

  it("rejects events from another thread", () => {
    expect(() =>
      projectThreadEvents(threadId, [
        projectionInput(
          createThreadEvent(
            "thread.created",
            {
              ...thread,
              id: "thr_other123",
            },
            1,
          ),
          1,
        ),
      ]),
    ).toThrow(ThreadProjectionError);
  });

  it("rejects projection sequence gaps and out-of-order inputs", () => {
    expect(() =>
      projectThreadEvents(threadId, [
        projectionInput(createThreadEvent("thread.created", thread, 1), 1),
        projectionInput(createItemEvent("item.completed", userItem, 3), 3),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_projection_sequence" }),
    );
  });

  it("returns null when replay has no thread state event", () => {
    const snapshot = projectThreadEvents(threadId, [
      projectionInput(createItemEvent("item.completed", userItem, 1), 1),
    ]);

    expect(snapshot).toBeNull();
  });
});

function projectionInput(event: PlatformEvent, projectionSequence: number) {
  return { event, projectionSequence };
}

function createThreadEvent(
  type:
    | "thread.created"
    | "thread.pinned"
    | "thread.archived",
  threadPayload: typeof thread,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, threadPayload.id, sequence),
    runId: null,
    scopeType: "thread",
    scopeId: threadPayload.id,
    type,
    payload: { thread: threadPayload },
  });
}

function createTitleEvent(
  title: string,
  source: "preview" | "generated" | "user",
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope("thread.title.updated", threadId, sequence),
    runId: null,
    scopeType: "thread",
    scopeId: threadId,
    type: "thread.title.updated",
    payload: {
      threadId,
      firstMessageId: "msg_first_user",
      title,
      titleVersion: sequence - 1,
      source,
      timestamp: `2026-06-09T12:0${sequence}:00.000Z`,
    },
  });
}

function createItemEvent(
  type: "item.completed",
  item: typeof userItem,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, item.threadId, sequence),
    runId: item.runId,
    scopeType: "run",
    scopeId: item.runId,
    type,
    payload: { item },
  });
}

function createTurnEvent(
  type: "turn.completed" | "turn.failed",
  turn: typeof firstTurn,
  sequence: number,
): PlatformEvent {
  return PlatformEventSchema.parse({
    ...baseEnvelope(type, turn.threadId, sequence),
    runId: turn.runId,
    scopeType: "run",
    scopeId: turn.runId,
    type,
    payload: { turn },
  });
}

function baseEnvelope(type: string, eventThreadId: string, sequence: number) {
  return {
    eventId: `evt_${sequence.toString().padStart(6, "0")}` as EventId,
    threadId: eventThreadId,
    workspaceId: "wrk_abc123",
    sequence,
    cursor: `cursor_${sequence.toString().padStart(6, "0")}` as EventCursor,
    idempotencyKey: `${eventThreadId}:${type}:${sequence}`,
    createdAt: timestamp,
    producer: { kind: "runtime_kernel", id: "kernel" },
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
}

const thread = {
  id: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  title: "Rebuild thread",
  titleSource: "generated",
  status: "active",
  pinnedAt: null,
  archivedAt: null,
  activeRunId: null,
  activeLeafItemId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};

const userItem = {
  id: "itm_user001",
  threadId: "thr_abc123",
  runId: "run_abc123",
  turnId: "trn_abc123",
  parentItemId: null,
  branchId: null,
  role: "user",
  status: "completed",
  createdAt: timestamp,
  completedAt: timestamp,
  eventSequence: 1,
  type: "user_message",
  content: { text: "Old prompt" },
};

const assistantItem = {
  ...userItem,
  id: "itm_asst001",
  role: "assistant",
  type: "assistant_message",
  content: { text: "Old answer" },
};

const firstTurn = {
  id: "trn_abc123",
  threadId: "thr_abc123",
  runId: "run_abc123",
  parentTurnId: null,
  status: "completed",
  startedAt: timestamp,
  completedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 2,
};

const secondTurn = {
  ...firstTurn,
  id: "trn_def456",
  lastEventSequence: 4,
};
