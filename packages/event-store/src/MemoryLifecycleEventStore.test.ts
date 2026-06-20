import { registerLifecycleSettlementConformance } from "@repo/contract-conformance";
import { LifecycleEventSchema } from "@repo/platform-protocol/lifecycle";
import { describe, expect, it } from "vitest";
import { EventStoreError } from "./errors.js";
import { MemoryLifecycleEventStore } from "./MemoryLifecycleEventStore.js";

registerLifecycleSettlementConformance(
  "memory lifecycle event store",
  () => createConformanceStore(),
);

describe("MemoryLifecycleEventStore", () => {
  it("diagnoses a sequence gap during replay", async () => {
    const store = new MemoryLifecycleEventStore();
    const first = lifecycleEvent(1, "turn.queued");
    const third = lifecycleEvent(3, "turn.started");

    await store.appendBatch([first, third]);
    await expect(
      store.replay({ turnId: first.turnId, afterSequence: null, limit: 10 }),
    ).rejects.toMatchObject({ code: "corrupt_event_stream" } satisfies Partial<EventStoreError>);
  });

  it("returns the original event for an exact idempotent retry", async () => {
    const store = new MemoryLifecycleEventStore();
    const event = lifecycleEvent(1, "turn.queued");
    await store.append(event);
    await expect(store.append(event)).resolves.toEqual(event);
  });
});

function createConformanceStore() {
  const store = new MemoryLifecycleEventStore();
  let appended: Parameters<typeof store.appendBatch>[0] = [];
  return {
    appendBatch: async (events: Parameters<typeof store.appendBatch>[0]) => {
      const result = await store.appendBatch(events);
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
}

function lifecycleEvent(
  sequence: number,
  type: "turn.queued" | "turn.started",
) {
  return LifecycleEventSchema.parse({
    eventId: `evt_memory${sequence}00`,
    threadId: "thr_memory001",
    turnId: "trn_memory001",
    runAttemptId: "attempt_memory001",
    sequence,
    idempotencyKey: `memory:${sequence}`,
    producer: { kind: "runtime_kernel", id: "memory-test" },
    schemaVersion: 1,
    createdAt: "2026-06-19T00:00:00.000Z",
    type,
    payload: {},
  });
}
