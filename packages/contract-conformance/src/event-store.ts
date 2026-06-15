import {
  EVENT_SCHEMA_VERSION,
  PlatformEventSchema,
  type EventCursor,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";

type StoreOwnedEventField = "eventId" | "sequence" | "cursor" | "createdAt";
type AppendEventInput = Omit<
  ReturnType<typeof PlatformEventSchema.parse>,
  StoreOwnedEventField
>;

interface EventStoreContract {
  append(input: AppendEventInput): Promise<ReturnType<typeof PlatformEventSchema.parse>>;
  appendBatch(
    inputs: readonly AppendEventInput[],
  ): Promise<readonly ReturnType<typeof PlatformEventSchema.parse>[]>;
  replay(input: {
    scope: { scopeType: string; scopeId: string };
    afterCursor: EventCursor | null;
    limit: number;
  }): Promise<{
    events: readonly ReturnType<typeof PlatformEventSchema.parse>[];
    nextCursor: EventCursor | null;
  }>;
}

export function registerEventStoreConformance(
  implementation: string,
  createStore: () => unknown | Promise<unknown>,
): void {
  describe(`${implementation} EventStore conformance`, () => {
    it("preserves scoped sequence, replay, and idempotency contracts", async () => {
      const store = (await createStore()) as EventStoreContract;
      const first = await store.append(createRunInput("created"));
      const retry = await store.append(createRunInput("created"));
      const second = await store.append(createRunInput("started", "run.started"));
      const replay = await store.replay({
        scope: { scopeType: "run", scopeId: "run_conformance" },
        afterCursor: first.cursor,
        limit: 10,
      });

      expect(retry).toEqual(first);
      expect(second.sequence).toBe(2);
      expect(replay.events).toEqual([second]);
      expect(replay.nextCursor).toBe(second.cursor);
    });

    it("rejects idempotency conflicts and cross-scope cursors with typed errors", async () => {
      const store = (await createStore()) as EventStoreContract;
      const first = await store.append(createRunInput("created"));

      await expect(
        store.append(createRunInput("created", "run.started")),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        store.replay({
          scope: { scopeType: "thread", scopeId: "thr_conformance" },
          afterCursor: first.cursor as EventCursor,
          limit: 10,
        }),
      ).rejects.toMatchObject({ code: "cursor_not_found" });
    });

    it("keeps batch append atomic when any input conflicts", async () => {
      const store = (await createStore()) as EventStoreContract;
      await store.append(createRunInput("existing"));

      await expect(
        store.appendBatch([
          createThreadInput(),
          createRunInput("existing", "run.started"),
        ]),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        store.replay({
          scope: { scopeType: "thread", scopeId: "thr_conformance" },
          afterCursor: null,
          limit: 10,
        }),
      ).resolves.toMatchObject({ events: [] });
    });
  });
}

function createThreadInput(): AppendEventInput {
  const runInput = createRunInput("unused");
  return {
    ...runInput,
    scopeType: "thread",
    scopeId: "thr_conformance",
    runId: null,
    idempotencyKey: "thread-created",
    type: "thread.created",
    payload: {
      thread: {
        id: "thr_conformance",
        userId: "usr_conformance",
        workspaceId: "wrk_conformance",
        title: "Conformance",
        titleSource: "user",
        status: "active",
        pinnedAt: null,
        archivedAt: null,
        activeRunId: null,
        activeLeafItemId: null,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
        lastEventSequence: 1,
      },
    },
  } as AppendEventInput;
}

function createRunInput(
  idempotencyKey: string,
  type: "run.created" | "run.started" = "run.created",
): AppendEventInput {
  const parsed = PlatformEventSchema.parse({
    eventId: "evt_source01",
    threadId: "thr_conformance",
    workspaceId: "wrk_conformance",
    runId: "run_conformance",
    sequence: 1,
    cursor: "cursor_source01",
    idempotencyKey,
    createdAt: "2026-06-15T00:00:00.000Z",
    producer: { kind: "runtime_kernel", id: "conformance" },
    schemaVersion: EVENT_SCHEMA_VERSION,
    scopeType: "run",
    scopeId: "run_conformance",
    type,
    payload: {
      run: {
        id: "run_conformance",
        threadId: "thr_conformance",
        userId: "usr_conformance",
        workspaceId: "wrk_conformance",
        status: type === "run.created" ? "queued" : "running",
        mode: "auto_edit",
        providerId: "openai",
        modelId: "gpt-4o",
        workerId: "worker_conformance",
        permissionProfileId: "perm_conformance",
        startedAt: null,
        completedAt: null,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
        lastEventSequence: 1,
      },
    },
  });
  const { eventId, sequence, cursor, createdAt, ...input } = parsed;
  void eventId;
  void sequence;
  void cursor;
  void createdAt;
  return input;
}
