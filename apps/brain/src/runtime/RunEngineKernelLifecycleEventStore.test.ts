import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { MemoryLifecycleEventStore } from "@repo/persistence";
import { RunEngineKernelLifecycleEventStore } from "./RunEngineKernelLifecycleEventStore";

describe("RunEngineKernelLifecycleEventStore", () => {
  it("persists canonical events and invokes transcript persistence after append", async () => {
    const backingStore = new MemoryLifecycleEventStore();
    const order: string[] = [];
    const store = new RunEngineKernelLifecycleEventStore({
      store: {
        append: async (event) => {
          const appended = await backingStore.append(event);
          order.push("append");
          return appended;
        },
        appendBatch: async (events) => {
          const appended = await backingStore.appendBatch(events);
          order.push("append");
          return appended;
        },
        replay: backingStore.replay.bind(backingStore),
      },
      onAssistantMessageDelta: async (event) => {
        order.push(`assistant:${event.type}`);
      },
    });

    await store.append(createLifecycleEvent("assistant_message.delta", 1));

    expect(order).toEqual(["append", "assistant:assistant_message.delta"]);
    await expect(
      backingStore.replay({
        turnId: "trn_kernelturn1",
        afterSequence: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      events: [{ type: "assistant_message.delta", sequence: 1 }],
    });
  });

  it("replays only canonical lifecycle events for the requested turn", async () => {
    const backingStore = new MemoryLifecycleEventStore();
    const store = new RunEngineKernelLifecycleEventStore({ store: backingStore });

    await store.appendBatch([
      createLifecycleEvent("turn.started", 1, "trn_kernelturn1"),
      createLifecycleEvent("turn.started", 1, "trn_kernelturn2"),
      createLifecycleEvent("turn.completed", 2, "trn_kernelturn1"),
    ]);

    await expect(
      store.replay({
        turnId: "trn_kernelturn1",
        afterSequence: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      nextSequence: 2,
      events: [
        { turnId: "trn_kernelturn1", sequence: 1 },
        { turnId: "trn_kernelturn1", sequence: 2 },
      ],
    });
  });
});

function createLifecycleEvent(
  type: LifecycleEvent["type"],
  sequence: number,
  turnId: LifecycleEvent["turnId"] = "trn_kernelturn1",
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_${turnId.slice(4)}_${sequence}`,
    threadId: "thr_kernel1",
    turnId,
    runAttemptId: "attempt_kernel1",
    sequence,
    idempotencyKey: `${turnId}:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "runtime-kernel-test" },
    schemaVersion: 1,
    createdAt: "2026-07-01T10:00:00.000Z",
    ...(type === "assistant_message.delta" ? { itemId: "itm_kernelmsg1" } : {}),
    type,
    payload:
      type === "turn.completed"
        ? { outcome: { status: "completed" } }
        : type === "assistant_message.delta"
          ? { delta: "completed" }
          : {},
  });
}
