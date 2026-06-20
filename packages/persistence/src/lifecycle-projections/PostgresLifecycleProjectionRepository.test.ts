import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { describe, expect, it } from "vitest";
import { LifecycleSqlClient } from "../lifecycle-events/test-fixtures.js";
import { PostgresLifecycleProjectionRepository } from "./PostgresLifecycleProjectionRepository.js";

describe("PostgresLifecycleProjectionRepository", () => {
  it("persists a rebuild cursor and survives repository reconstruction", async () => {
    const client = new LifecycleSqlClient();
    const events = completedEvents();
    const first = new PostgresLifecycleProjectionRepository(client);
    const rebuilt = await first.rebuild(events);
    const reconstructed = new PostgresLifecycleProjectionRepository(client);
    await expect(reconstructed.get(events[0]?.turnId ?? "")).resolves.toEqual(
      rebuilt,
    );
    expect(rebuilt).toMatchObject({ lastSequence: 5, status: "completed" });
  });
});

function completedEvents(): LifecycleEvent[] {
  return [
    event(1, "turn.queued", {}),
    event(2, "turn.started", {}),
    event(3, "run_attempt.started", {}),
    event(4, "run_attempt.succeeded", {}),
    event(5, "turn.completed", { outcome: { status: "completed" } }),
  ];
}

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  payload: object,
) {
  return LifecycleEventSchema.parse({
    eventId: `evt_cursor${sequence}00`,
    threadId: "thr_cursor001",
    turnId: "trn_cursor001",
    runAttemptId: "attempt_cursor001",
    sequence,
    idempotencyKey: `cursor:${sequence}`,
    producer: { kind: "runtime_kernel", id: "cursor-test" },
    schemaVersion: 1,
    createdAt: "2026-06-20T00:00:00.000Z",
    type,
    payload,
  });
}
