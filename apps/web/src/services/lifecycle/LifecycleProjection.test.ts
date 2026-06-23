import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  type ApprovalId,
  type EventId,
  type EventIdempotencyKey,
  type ItemId,
  type LifecycleEvent,
  type RunAttemptId,
  type ThreadId,
  type TurnId,
} from "../api/lifecycleClient";
import {
  createLifecycleProjection,
  replayLifecycleProjection,
  applyLifecycleEvent,
} from "./LifecycleProjection";

const THREAD_ID = "thr_life01" as ThreadId;
const TURN_ID = "trn_life01" as TurnId;
const RUN_ATTEMPT_ID = "attempt_life01" as RunAttemptId;
const REASONING_ITEM_ID = "itm_reason01" as ItemId;
const ASSISTANT_ITEM_ID = "itm_assist01" as ItemId;
const APPROVAL_ITEM_ID = "itm_approv01" as ItemId;
const APPROVAL_ID = "appr_life01" as ApprovalId;

describe("LifecycleProjection", () => {
  it("clears active thinking when the canonical terminal event arrives", () => {
    const projection = replayLifecycleProjection(TURN_ID, [
      lifecycleEvent(1, "item.started", {
        itemId: REASONING_ITEM_ID,
        payload: { kind: "reasoning" },
      }),
      lifecycleEvent(2, "reasoning.summary_delta", {
        itemId: REASONING_ITEM_ID,
        payload: { summary: "private chain summary" },
      }),
      lifecycleEvent(3, "turn.completed", {
        payload: { outcome: { status: "completed" } },
      }),
    ]);

    expect(projection.terminal?.state).toBe("completed");
    expect(projection.activeThinking).toBe(false);
  });

  it("keeps assistant final text separate from reasoning summaries", () => {
    const projection = replayLifecycleProjection(TURN_ID, [
      lifecycleEvent(1, "item.started", {
        itemId: REASONING_ITEM_ID,
        payload: { kind: "reasoning" },
      }),
      lifecycleEvent(2, "reasoning.summary_delta", {
        itemId: REASONING_ITEM_ID,
        payload: { summary: "hidden reasoning summary" },
      }),
      lifecycleEvent(3, "item.started", {
        itemId: ASSISTANT_ITEM_ID,
        payload: { kind: "assistant_message" },
      }),
      lifecycleEvent(4, "assistant_message.delta", {
        itemId: ASSISTANT_ITEM_ID,
        payload: { delta: "Ready to review." },
      }),
      lifecycleEvent(5, "item.completed", {
        itemId: ASSISTANT_ITEM_ID,
        payload: { result: { text: "Ready to review." } },
      }),
    ]);

    expect(projection.assistantText).toBe("Ready to review.");
    expect(projection.assistantText).not.toContain("hidden reasoning");
  });

  it("keeps approval blocking visible until the approval is resolved", () => {
    const requested = applyLifecycleEvent(
      createLifecycleProjection(TURN_ID),
      lifecycleEvent(1, "approval.requested", {
        itemId: APPROVAL_ITEM_ID,
        approvalId: APPROVAL_ID,
        payload: { prompt: "Run command?" },
      }),
    );

    expect(requested.pendingApproval?.approvalId).toBe(APPROVAL_ID);

    const decided = applyLifecycleEvent(
      requested,
      lifecycleEvent(2, "approval.decided", {
        itemId: APPROVAL_ITEM_ID,
        approvalId: APPROVAL_ID,
        payload: { decision: "approved" },
      }),
    );

    expect(decided.pendingApproval?.decision).toBe("approved");

    const resolved = applyLifecycleEvent(
      decided,
      lifecycleEvent(3, "request.resolved", {
        itemId: APPROVAL_ITEM_ID,
        requestId: "approval-resolution",
        payload: { resolved: true },
      }),
    );

    expect(resolved.pendingApproval).toBeNull();
  });

  it("records turn diff only from the canonical turn diff event", () => {
    const projection = applyLifecycleEvent(
      createLifecycleProjection(TURN_ID),
      lifecycleEvent(1, "turn.diff_updated", {
        payload: {
          diff: {
            turnId: TURN_ID,
            startSnapshot: {
              turnId: TURN_ID,
              snapshotKey: "start",
              treeId: "a".repeat(40),
              headSha: "b".repeat(40),
              phase: "start",
              capturedAt: "2026-06-23T00:00:00.000Z",
            },
            terminalSnapshot: {
              turnId: TURN_ID,
              snapshotKey: "terminal",
              treeId: "c".repeat(40),
              headSha: "d".repeat(40),
              phase: "terminal",
              capturedAt: "2026-06-23T00:00:01.000Z",
            },
            files: [],
            patch: "",
          },
        },
      }),
    );

    expect(projection.turnDiff?.turnId).toBe(TURN_ID);
    expect(projection.turnDiff?.files).toEqual([]);
  });
});

function lifecycleEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  overrides: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_life${String(sequence).padStart(3, "0")}` as EventId,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    runAttemptId: RUN_ATTEMPT_ID,
    sequence,
    idempotencyKey: `${type}.${sequence}` as EventIdempotencyKey,
    producer: { kind: "runtime_kernel", id: "web-projection-test" },
    schemaVersion: 1,
    createdAt: `2026-06-23T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload: {},
    ...overrides,
  });
}
