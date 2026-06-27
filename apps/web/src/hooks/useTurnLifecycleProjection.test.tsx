import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LifecycleEventSchema,
  type EventId,
  type EventIdempotencyKey,
  type ItemId,
  type LifecycleClient,
  type LifecycleEvent,
  type RunAttemptId,
  type ThreadId,
  type TurnId,
} from "../services/api/lifecycleClient";
import { useTurnLifecycleProjection } from "./useTurnLifecycleProjection";

const THREAD_ID = "thr_hook01" as ThreadId;
const TURN_ID = "trn_hook01" as TurnId;
const RUN_ATTEMPT_ID = "attempt_hook01" as RunAttemptId;
const ITEM_ID = "itm_hook01" as ItemId;

describe("useTurnLifecycleProjection", () => {
  it("follows canonical lifecycle events into a projection", async () => {
    const client = createClient([
      lifecycleEvent(1, "item.started", {
        itemId: ITEM_ID,
        payload: { kind: "reasoning" },
      }),
      lifecycleEvent(2, "turn.completed", {
        payload: { outcome: { status: "completed" } },
      }),
    ]);

    const { result } = renderHook(() =>
      useTurnLifecycleProjection(TURN_ID, true, client),
    );

    await waitFor(() => {
      expect(result.current.projection?.terminal?.state).toBe("completed");
    });
    expect(result.current.projection?.activeThinking).toBe(false);
  });

  it("does not reinterpret legacy run IDs as canonical turn IDs", async () => {
    const client = createClient([]);

    const { result } = renderHook(() =>
      useTurnLifecycleProjection("run-legacy", true, client),
    );

    expect(result.current.projection).toBeNull();
    expect(client.followTurnLifecycle).not.toHaveBeenCalled();
  });
});

function createClient(events: readonly LifecycleEvent[]): LifecycleClient {
  return {
    startTurn: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    followTurnLifecycle: vi.fn(async function* () {
      yield* events;
    }),
    submitApproval: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    submitUserInputResponse: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    getTurnDiff: vi.fn(async () => null),
  };
}

function lifecycleEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  overrides: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_hook${String(sequence).padStart(3, "0")}` as EventId,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    runAttemptId: RUN_ATTEMPT_ID,
    sequence,
    idempotencyKey: `${type}.${sequence}` as EventIdempotencyKey,
    producer: { kind: "runtime_kernel", id: "web-hook-test" },
    schemaVersion: 1,
    createdAt: `2026-06-23T00:01:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload: {},
    ...overrides,
  });
}
