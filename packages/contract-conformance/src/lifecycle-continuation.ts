import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  type EventId,
  type EventIdempotencyKey,
  type LifecycleEvent,
  type RunAttemptId,
  type ThreadId,
  type TurnId,
} from "@repo/platform-protocol";

export interface LifecycleContinuationScenario {
  readonly replayEvents: readonly LifecycleEvent[];
  readonly liveEvents: readonly LifecycleEvent[];
}

export interface LifecycleContinuationFixture {
  follow(): AsyncIterable<LifecycleEvent>;
}

export function registerLifecycleContinuationConformance(
  implementation: string,
  createFixture: (
    scenario: LifecycleContinuationScenario,
  ) => LifecycleContinuationFixture,
): void {
  describe(`${implementation} lifecycle continuation conformance`, () => {
    it("yields replayed events before live continuation events", async () => {
      const fixture = createFixture({
        replayEvents: [lifecycleEvent(1)],
        liveEvents: [lifecycleEvent(2)],
      });

      await expect(readAll(fixture.follow())).resolves.toMatchObject([
        { sequence: 1 },
        { sequence: 2 },
      ]);
    });

    it("ignores duplicated replay events from live continuation", async () => {
      const first = lifecycleEvent(1);
      const fixture = createFixture({
        replayEvents: [first],
        liveEvents: [first, lifecycleEvent(2)],
      });

      await expect(readAll(fixture.follow())).resolves.toMatchObject([
        { sequence: 1 },
        { sequence: 2 },
      ]);
    });

    it("fails explicitly when live continuation skips a sequence", async () => {
      const fixture = createFixture({
        replayEvents: [lifecycleEvent(1)],
        liveEvents: [lifecycleEvent(3)],
      });

      await expect(readAll(fixture.follow())).rejects.toMatchObject({
        code: "lifecycle_sequence_gap",
        expectedSequence: 2,
        receivedSequence: 3,
      });
    });
  });
}

export function lifecycleEvent(sequence: number): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_continue${String(sequence).padStart(3, "0")}` as EventId,
    threadId: "thr_continue" as ThreadId,
    turnId: "trn_continue" as TurnId,
    runAttemptId: "attempt_continue" as RunAttemptId,
    sequence,
    idempotencyKey: `turn.started.${sequence}` as EventIdempotencyKey,
    producer: { kind: "runtime_kernel", id: "continuation-conformance" },
    schemaVersion: 1,
    createdAt: "2026-06-23T00:00:00.000Z",
    type: "turn.started",
    payload: { turnId: "trn_continue" },
  });
}

async function readAll<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
