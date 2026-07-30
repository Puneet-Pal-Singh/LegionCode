import { describe, expect, it } from "vitest";
import { TurnIdSchema } from "@repo/platform-protocol";
import { createLifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { mergeLifecycleProjections } from "./mergeLifecycleProjections";

describe("mergeLifecycleProjections", () => {
  it("keeps a prior live turn while durable replay catches up", () => {
    const previous = createLifecycleProjection(
      TurnIdSchema.parse("trn_previous01"),
    );
    const active = createLifecycleProjection(
      TurnIdSchema.parse("trn_active0001"),
    );

    const result = mergeLifecycleProjections(
      {},
      { [previous.turnId]: previous },
      active,
    );

    expect(result[previous.turnId]).toBe(previous);
    expect(result[active.turnId]).toBe(active);
  });

  it("never aliases an active projection onto another turn id", () => {
    const active = createLifecycleProjection(
      TurnIdSchema.parse("trn_active0001"),
    );
    const result = mergeLifecycleProjections({}, {}, active);

    expect(Object.keys(result)).toEqual([active.turnId]);
  });

  it("prefers durable replay once it catches up with an observed turn", () => {
    const turnId = TurnIdSchema.parse("trn_replayed001");
    const observed = createLifecycleProjection(turnId);
    const replayed = {
      ...createLifecycleProjection(turnId),
      lastSequence: 1,
      terminal: {
        state: "completed" as const,
        eventId: "evt-terminal",
        content: "completed",
        occurredAt: "2026-07-29T00:00:00.000Z",
      },
    };

    const result = mergeLifecycleProjections(
      { [turnId]: replayed },
      { [turnId]: observed },
      null,
    );

    expect(result[turnId]).toBe(replayed);
  });

  it("does not let stale replay hide newer live workflow activity", () => {
    const turnId = TurnIdSchema.parse("trn_live_newer01");
    const replayed = {
      ...createLifecycleProjection(turnId),
      lastSequence: 2,
    };
    const observed = {
      ...createLifecycleProjection(turnId),
      lastSequence: 5,
      phase: "working" as const,
    };

    const result = mergeLifecycleProjections(
      { [turnId]: replayed },
      { [turnId]: observed },
      null,
    );

    expect(result[turnId]).toBe(observed);
  });
});
