import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { RunEngineKernelLifecycleEventStore } from "./RunEngineKernelLifecycleEventStore";
import type { CanonicalRunEventSink } from "./RunEngineRequestHandler";

describe("RunEngineKernelLifecycleEventStore", () => {
  it("keeps RuntimeKernel lifecycle events out of the user activity sink", async () => {
    const persistedEvents: Parameters<CanonicalRunEventSink["persist"]>[0][] =
      [];
    const liveEvents: Parameters<CanonicalRunEventSink["persist"]>[0][] = [];
    const store = new RunEngineKernelLifecycleEventStore({
      runId: "run_123e4567e89b42d3a456426614174999",
      sessionId: "session-kernel",
      correlationId: "corr-kernel",
      sink: {
        async persist(event) {
          persistedEvents.push(event);
        },
      },
      onRunEvent(event) {
        liveEvents.push(event);
      },
    });

    await store.append(createLifecycleEvent("turn.completed", 9));

    expect(persistedEvents).toHaveLength(0);
    expect(liveEvents).toHaveLength(0);
    await expect(
      store.replay({
        turnId: "trn_kernelturn1",
        afterSequence: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      nextSequence: 9,
      events: [{ type: "turn.completed", sequence: 9 }],
    });
  });

  it("replays only canonical lifecycle events for the requested turn", async () => {
    const store = new RunEngineKernelLifecycleEventStore({
      runId: "run_123e4567e89b42d3a456426614174999",
      sessionId: "session-kernel",
      correlationId: "corr-kernel",
      sink: { async persist() {} },
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
});

function createLifecycleEvent(
  type: LifecycleEvent["type"],
  sequence: number,
  turnId: LifecycleEvent["turnId"] = "trn_kernelturn1",
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_kernelturn1_${sequence}`,
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
      type === "turn.completed"
        ? { outcome: { status: "completed" } }
        : {},
  });
}
