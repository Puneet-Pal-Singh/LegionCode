import { LifecycleEventSchema, type LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import { describe, expect, it } from "vitest";
import { LifecycleProjector, projectLifecycleEvents } from "./LifecycleProjector.js";
import { LifecycleProjectionError } from "./types.js";

describe("LifecycleProjector", () => {
  it("rebuilds the same terminal projection as incremental application", () => {
    const events = completedEvents();
    const projector = new LifecycleProjector(events[0]?.turnId ?? "trn_projection001");
    let live = null;
    for (const event of events) live = projector.apply(event);

    expect(projectLifecycleEvents(events)).toEqual(live);
    expect(live).toMatchObject({
      status: "completed",
      terminalOutcome: { status: "completed" },
      items: [{ kind: "assistant_message", status: "completed", text: "Done" }],
    });
  });

  it("does not infer a terminal outcome from a completed item", () => {
    const projection = projectLifecycleEvents(completedEvents().slice(0, 6));
    expect(projection).toMatchObject({ status: "in_progress", terminalOutcome: null });
  });

  it("rejects projection gaps and post-terminal events", () => {
    const events = completedEvents();
    expect(() => projectLifecycleEvents([events[0] as LifecycleEvent, events[2] as LifecycleEvent])).toThrow(
      LifecycleProjectionError,
    );
    expect(() =>
      projectLifecycleEvents([...events, event(9, "turn.blocking_changed", { blockingState: { kind: "none" } })]),
    ).toThrow(LifecycleProjectionError);
  });
});

function completedEvents(): LifecycleEvent[] {
  return [
    event(1, "turn.queued", {}),
    event(2, "turn.started", {}),
    event(3, "run_attempt.started", {}),
    event(4, "item.started", { kind: "assistant_message" }, "itm_projection001"),
    event(5, "assistant_message.delta", { delta: "Done" }, "itm_projection001"),
    event(6, "item.completed", { result: { output: "Done" } }, "itm_projection001"),
    event(7, "run_attempt.succeeded", {}),
    event(8, "turn.completed", { outcome: { status: "completed" } }),
  ];
}

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  payload: Record<string, unknown>,
  itemId?: string,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_projection${sequence}00`,
    threadId: "thr_projection001",
    turnId: "trn_projection001",
    runAttemptId: "attempt_projection001",
    sequence,
    idempotencyKey: `projection:${sequence}`,
    producer: { kind: "runtime_kernel", id: "projection-test" },
    schemaVersion: 1,
    createdAt: "2026-06-20T00:00:00.000Z",
    type,
    payload,
    ...(itemId ? { itemId } : {}),
  });
}
