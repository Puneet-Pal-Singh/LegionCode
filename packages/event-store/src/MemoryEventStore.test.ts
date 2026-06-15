import {
  EVENT_SCHEMA_VERSION,
  EventScopeSchema,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
} from "@repo/platform-protocol";
import { registerEventStoreConformance } from "@repo/contract-conformance";
import { describe, expect, it } from "vitest";
import { MemoryEventStore } from "./MemoryEventStore.js";
import type {
  AppendEventInput,
  EventStoreIdGenerator,
} from "./types.js";

const timestamp = "2026-06-09T10:00:00.000Z";
const clock = { now: () => timestamp };
const runScope = EventScopeSchema.parse({
  scopeType: "run",
  scopeId: "run_abc123",
});
const threadScope = EventScopeSchema.parse({
  scopeType: "thread",
  scopeId: "thr_abc123",
});

describe("MemoryEventStore", () => {
  it("assigns store-owned fields and independent per-scope sequences", async () => {
    const store = createStore();

    const runEvent = await store.append(createRunEventInput("run:created"));
    const threadEvent = await store.append(createThreadEventInput());
    const nextRunEvent = await store.append(
      createRunEventInput("run:started", "run.started"),
    );

    expect(runEvent).toMatchObject({
      eventId: "evt_event001",
      cursor: "cursor_cursor001",
      sequence: 1,
      createdAt: timestamp,
    });
    expect(threadEvent.sequence).toBe(1);
    expect(nextRunEvent.sequence).toBe(2);
  });

  it("returns exact idempotent retries and rejects changed input", async () => {
    const store = createStore();
    const input = createToolEventInput({ zeta: true, alpha: "same" });

    const first = await store.append(input);
    const retry = await store.append(
      createToolEventInput({ alpha: "same", zeta: true }),
    );

    expect(retry).toEqual(first);
    await expect(
      store.append(createToolEventInput({ alpha: "changed", zeta: true })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("keeps batch append atomic when a later event conflicts", async () => {
    const store = createStore();
    await store.append(createRunEventInput("run:existing"));

    await expect(
      store.appendBatch([
        createThreadEventInput(),
        createRunEventInput("run:existing", "run.started"),
      ]),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const replay = await store.replay({
      scope: threadScope,
      afterCursor: null,
      limit: 10,
    });
    expect(replay.events).toEqual([]);
  });

  it("replays by scope and cursor without leaking cross-scope cursors", async () => {
    const store = createStore();
    const first = await store.append(createRunEventInput("run:created"));
    const second = await store.append(
      createRunEventInput("run:started", "run.started"),
    );
    await store.append(createThreadEventInput());

    const replay = await store.replay({
      scope: runScope,
      afterCursor: first.cursor,
      limit: 1,
    });
    expect(replay.events).toEqual([second]);
    expect(replay.nextCursor).toBe(second.cursor);

    await expect(
      store.replay({
        scope: threadScope,
        afterCursor: first.cursor,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "cursor_not_found" });
  });

  it("rejects invalid replay limits and duplicate store IDs", async () => {
    const store = createStore({
      eventIds: ["evt_duplicate1", "evt_duplicate1"],
    });
    await store.append(createRunEventInput("run:created"));

    await expect(
      store.append(createRunEventInput("run:started", "run.started")),
    ).rejects.toMatchObject({ code: "event_id_conflict" });
    await expect(
      store.replay({
        scope: runScope,
        afterCursor: "not-a-cursor" as EventCursor,
        limit: 10,
      }),
    ).rejects.toThrow();
    await expect(
      store.replay({
        scope: runScope,
        afterCursor: null,
        limit: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_replay_limit" });
  });

  it("returns clones so callers cannot mutate canonical history", async () => {
    const store = createStore();
    const appended = await store.append(createRunEventInput("run:created"));
    if (appended.type !== "run.created") {
      throw new Error("Expected run.created event");
    }
    appended.payload.run.status = "completed";

    const replay = await store.replay({
      scope: runScope,
      afterCursor: null,
      limit: 10,
    });
    expect(replay.events[0]?.type).toBe("run.created");
    expect(replay.events[0]?.payload).toMatchObject({
      run: { status: "running" },
    });
  });
});

registerEventStoreConformance("MemoryEventStore", createStore);

function createStore(
  overrides: {
    eventIds?: readonly string[];
    cursors?: readonly string[];
  } = {},
): MemoryEventStore {
  return new MemoryEventStore(
    clock,
    createIdGenerator(overrides.eventIds, overrides.cursors),
  );
}

function createIdGenerator(
  eventIds: readonly string[] = [
    "evt_event001",
    "evt_event002",
    "evt_event003",
  ],
  cursors: readonly string[] = [
    "cursor_cursor001",
    "cursor_cursor002",
    "cursor_cursor003",
  ],
): EventStoreIdGenerator {
  let eventIndex = 0;
  let cursorIndex = 0;
  return {
    nextEventId: () => eventIds[eventIndex++] as EventId,
    nextCursor: () => cursors[cursorIndex++] as EventCursor,
  };
}

function createRunEventInput(
  idempotencyKey: string,
  type: "run.created" | "run.started" = "run.created",
): AppendEventInput {
  return toAppendInput({
    ...baseEnvelope,
    scopeType: "run",
    scopeId: "run_abc123",
    runId: "run_abc123",
    idempotencyKey,
    type,
    payload: { run },
  });
}

function createThreadEventInput(): AppendEventInput {
  return toAppendInput({
    ...baseEnvelope,
    scopeType: "thread",
    scopeId: "thr_abc123",
    runId: null,
    idempotencyKey: "thread:created",
    type: "thread.created",
    payload: { thread },
  });
}

function createToolEventInput(
  input: Record<string, string | boolean>,
): AppendEventInput {
  return toAppendInput({
    ...baseEnvelope,
    scopeType: "run",
    scopeId: "run_abc123",
    runId: "run_abc123",
    idempotencyKey: "tool:requested",
    type: "tool.call.requested",
    payload: {
      itemId: "itm_abc123",
      content: {
        toolCallId: "toolcall_abc123",
        toolName: "read_file",
        input,
      },
    },
  });
}

function toAppendInput(event: unknown): AppendEventInput {
  const parsed = PlatformEventSchema.parse(event);
  const { eventId, sequence, cursor, createdAt, ...input } = parsed;
  void eventId;
  void sequence;
  void cursor;
  void createdAt;
  return input;
}

const baseEnvelope = {
  eventId: "evt_source01",
  threadId: "thr_abc123",
  workspaceId: "wrk_abc123",
  sequence: 1,
  cursor: "cursor_source01",
  createdAt: timestamp,
  producer: { kind: "runtime_kernel", id: "kernel" },
  schemaVersion: EVENT_SCHEMA_VERSION,
};

const run = {
  id: "run_abc123",
  threadId: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  status: "running",
  mode: "auto_edit",
  providerId: "openrouter",
  modelId: "z-ai/glm-4.5-air:free",
  workerId: "worker_abc123",
  permissionProfileId: "perm_abc123",
  startedAt: timestamp,
  completedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};

const thread = {
  id: "thr_abc123",
  userId: "usr_abc123",
  workspaceId: "wrk_abc123",
  title: "Rebuild thread",
  titleSource: "user",
  status: "active",
  pinnedAt: null,
  archivedAt: null,
  activeRunId: "run_abc123",
  activeLeafItemId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 1,
};
