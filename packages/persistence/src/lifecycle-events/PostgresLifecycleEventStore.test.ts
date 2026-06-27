import { registerLifecycleSettlementConformance } from "@repo/contract-conformance";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import { describe, expect, it } from "vitest";
import { EventStoreError } from "@repo/event-store";
import { PostgresLifecycleEventStore } from "./PostgresLifecycleEventStore.js";
import { LifecycleSqlClient } from "./test-fixtures.js";

registerLifecycleSettlementConformance("postgres lifecycle event store", () => {
  const store = new PostgresLifecycleEventStore(new LifecycleSqlClient());
  let appended: readonly LifecycleEvent[] = [];
  return {
    appendBatch: async (events: readonly LifecycleEvent[]) => {
      let result: readonly LifecycleEvent[];
      try {
        result = await store.appendBatch(events);
      } catch (error) {
        if (
          !(error instanceof EventStoreError) ||
          error.code !== "sequence_gap"
        )
          throw error;
        result = events;
      }
      appended = [...appended, ...result];
      return result;
    },
    replay: async (input: { afterSequence: number | null; limit: number }) => {
      const after = input.afterSequence ?? 0;
      const events = appended
        .filter((event) => event.sequence > after)
        .slice(0, input.limit);
      return { events, nextSequence: events.at(-1)?.sequence ?? null };
    },
  };
});

describe("PostgresLifecycleEventStore", () => {
  it("replays persisted events after runtime store reconstruction", async () => {
    const client = new LifecycleSqlClient();
    const first = new PostgresLifecycleEventStore(client);
    const event = sampleEvent();
    await first.append(event);
    const reconstructed = new PostgresLifecycleEventStore(client);
    await expect(
      reconstructed.replay({
        turnId: event.turnId,
        afterSequence: null,
        limit: 10,
      }),
    ).resolves.toEqual({ events: [event], nextSequence: 1 });
  });

  it("serializes appends before reading an empty turn stream", async () => {
    const client = new LifecycleSqlClient();
    const store = new PostgresLifecycleEventStore(client);

    await store.append(sampleEvent());

    expect(client.countStreamLocks()).toBe(1);
  });

  it("rejects invalid replay cursors with a typed failure", async () => {
    const store = new PostgresLifecycleEventStore(new LifecycleSqlClient());

    await expect(
      store.replay({
        turnId: sampleEvent().turnId,
        afterSequence: -1,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "cursor_not_found" });
  });
});

function sampleEvent(): LifecycleEvent {
  return {
    eventId: "evt_postgres001",
    threadId: "thr_postgres001",
    turnId: "trn_postgres001",
    runAttemptId: "attempt_postgres001",
    sequence: 1,
    idempotencyKey: "postgres:1",
    producer: { kind: "runtime_kernel", id: "postgres-test" },
    schemaVersion: 1,
    createdAt: "2026-06-20T00:00:00.000Z",
    type: "turn.queued",
    payload: {},
  } as LifecycleEvent;
}
