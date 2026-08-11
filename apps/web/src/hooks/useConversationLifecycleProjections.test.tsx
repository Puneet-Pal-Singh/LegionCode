import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationTurn } from "../components/chat/messageMetadata";
import {
  LifecycleEventSchema,
  type EventId,
  type EventIdempotencyKey,
  type LifecycleClient,
  type LifecycleEvent,
  type RunAttemptId,
  type ThreadId,
  type TurnId,
} from "../services/api/lifecycleClient";
import { useConversationLifecycleProjections } from "./useConversationLifecycleProjections";

const THREAD_ID = "thr_history01" as ThreadId;
const TURN_ID = "trn_history01" as TurnId;
const RUN_ATTEMPT_ID = "attempt_history01" as RunAttemptId;

describe("useConversationLifecycleProjections", () => {
  it("keeps historical workflow replay behind one settled loading boundary", async () => {
    let releaseReplay: (() => void) | null = null;
    const replayReleased = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const client = createClient(async function* () {
      yield lifecycleEvent(1, "turn.started", {});
      await replayReleased;
      yield lifecycleEvent(2, "turn.completed", {
        payload: { outcome: { status: "completed" } },
      });
    });
    const turns: ConversationTurn[] = [
      {
        key: "turn:user-1",
        userMessage: { id: "user-1", role: "user", content: "Edit it" },
        assistantMessage: {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
        },
        turnId: TURN_ID,
      },
    ];

    const { result } = renderHook(() =>
      useConversationLifecycleProjections(turns, null, client),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.projections).toEqual({});

    await act(async () => {
      releaseReplay?.();
      await replayReleased;
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.projections[TURN_ID]?.terminal?.state).toBe(
      "completed",
    );
  });
});

function createClient(
  follow: () => AsyncGenerator<LifecycleEvent>,
): LifecycleClient {
  return {
    startTurn: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    followTurnLifecycle: vi.fn(follow),
    submitApproval: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    submitUserInputResponse: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    getTurnDiff: vi.fn(async () => null),
    interruptTurn: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
    compactTurn: vi.fn(async () => {
      throw new Error("Unsupported test operation");
    }),
  };
}

function lifecycleEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  overrides: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_history${String(sequence).padStart(3, "0")}` as EventId,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    runAttemptId: RUN_ATTEMPT_ID,
    sequence,
    idempotencyKey: `${type}.${sequence}` as EventIdempotencyKey,
    producer: { kind: "runtime_kernel", id: "history-replay-test" },
    schemaVersion: 1,
    createdAt: `2026-08-11T16:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload: {},
    ...overrides,
  });
}
