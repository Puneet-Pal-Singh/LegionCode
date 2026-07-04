import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { MemoryLifecycleEventStore } from "@repo/event-store";
import { RunEngineKernelLifecycleEventStore } from "./RunEngineKernelLifecycleEventStore";
import type { LifecycleEventStreamPort } from "./ports";

describe("RunEngineKernelLifecycleEventStore", () => {
  it("persists and emits lifecycle events from the same append path", async () => {
    const backingStore = new MemoryLifecycleEventStore();
    const stream = new CapturingLifecycleStream();
    const store = new RunEngineKernelLifecycleEventStore({
      runId: "run_123e4567e89b42d3a456426614174999",
      sessionId: "session-kernel",
      correlationId: "corr-kernel",
      store: backingStore,
      stream,
    });

    await store.append(createLifecycleEvent("turn.completed", 1));

    expect(stream.events).toMatchObject([
      { type: "turn.completed", sequence: 1 },
    ]);
    expect(stream.completedTurns).toEqual(["trn_kernelturn1"]);
    await expect(
      backingStore.replay({
        turnId: "trn_kernelturn1",
        afterSequence: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      nextSequence: 1,
      events: [{ type: "turn.completed", sequence: 1 }],
    });
  });

  it("replays only canonical lifecycle events for the requested turn", async () => {
    const backingStore = new MemoryLifecycleEventStore();
    const store = new RunEngineKernelLifecycleEventStore({
      runId: "run_123e4567e89b42d3a456426614174999",
      sessionId: "session-kernel",
      correlationId: "corr-kernel",
      store: backingStore,
      stream: new CapturingLifecycleStream(),
    });

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

  it("keeps canonical lifecycle persistence when live stream delivery fails", async () => {
    const backingStore = new MemoryLifecycleEventStore();
    const store = new RunEngineKernelLifecycleEventStore({
      runId: "run_123e4567e89b42d3a456426614174999",
      sessionId: "session-kernel",
      correlationId: "corr-kernel",
      store: backingStore,
      stream: new ThrowingLifecycleStream(),
    });

    await store.append(createLifecycleEvent("turn.completed", 1));

    await expect(
      backingStore.replay({
        turnId: "trn_kernelturn1",
        afterSequence: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      events: [{ type: "turn.completed", sequence: 1 }],
    });
  });
});

class CapturingLifecycleStream implements LifecycleEventStreamPort {
  readonly events: LifecycleEvent[] = [];
  readonly completedTurns: string[] = [];

  start(): void {}

  emit(event: LifecycleEvent): void {
    this.events.push(event);
  }

  complete(turnId: string): void {
    this.completedTurns.push(turnId);
  }

  getStream(): ReadableStream<Uint8Array> {
    return new ReadableStream();
  }
}

class ThrowingLifecycleStream implements LifecycleEventStreamPort {
  start(): void {}

  emit(): void {
    throw new Error("stream emit unavailable");
  }

  complete(): void {
    throw new Error("stream complete unavailable");
  }

  getStream(): ReadableStream<Uint8Array> {
    return new ReadableStream();
  }
}

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
    type,
    payload:
      type === "turn.completed" ? { outcome: { status: "completed" } } : {},
  });
}
