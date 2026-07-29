import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  TurnIdSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import {
  buildSegmentTitle,
  groupToolActivity,
} from "./tool-activity-grouping.js";
import {
  applyLifecycleEvent,
  createTurnWorkflowProjection,
  replayTurnWorkflowProjection,
} from "./turn-workflow-projection.js";

const TURN_ID = TurnIdSchema.parse("trn_workflow01");
const THREAD_ID = "thr_workflow01";
const ATTEMPT_ID = "attempt_workflow01";

describe("turn workflow projection", () => {
  it("preserves typed tool families and repeated ordered children", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      toolStarted(1, "itm_read01", "toolcall_read01", "read", "Read README.md"),
      toolCompleted(2, "itm_read01", "toolcall_read01"),
      toolStarted(3, "itm_edit01", "toolcall_edit01", "read", "Edit README.md"),
      toolCompleted(4, "itm_edit01", "toolcall_edit01"),
    ]);

    const segments = groupToolActivity(projection.items);
    expect(projection.items.map((item) => item.toolFamily)).toEqual([
      "read",
      "read",
    ]);
    expect(projection.items.map((item) => item.kind)).toEqual([
      "tool_call",
      "tool_call",
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.familyLabels).toEqual(["read"]);
    expect(segments[0]?.children.map((item) => item.itemId)).toEqual([
      "itm_read01",
      "itm_edit01",
    ]);
    expect(segments[0]?.children[0]?.detail).toBe("Read README.md");
    expect(buildSegmentTitle(segments[0]!)).toBe("read files");
  });

  it("does not synthesize item settlement from a terminal event", () => {
    const projection = applyLifecycleEvent(
      applyLifecycleEvent(
        createTurnWorkflowProjection(TURN_ID),
        toolStarted(
          1,
          "itm_read01",
          "toolcall_read01",
          "read",
          "Read README.md",
        ),
      ),
      event(2, "turn.interrupted", {
        payload: {
          outcome: { status: "interrupted", reason: "User stopped the turn." },
        },
      }),
    );

    expect(projection.phase).toBe("interrupted");
    expect(projection.terminal?.state).toBe("interrupted");
    expect(projection.items[0]).toMatchObject({
      itemId: "itm_read01",
      status: "active",
      completedAt: null,
    });
  });

  it("uses explicit item settlement evidence before the interrupted terminal", () => {
    const projection = replayTurnWorkflowProjection(TURN_ID, [
      toolStarted(1, "itm_read01", "toolcall_read01", "read", "Read README.md"),
      event(2, "tool_call.interrupted", {
        itemId: "itm_read01",
        toolCallId: "toolcall_read01",
        payload: { reason: "User stopped the turn." },
      }),
      event(3, "item.interrupted", {
        itemId: "itm_read01",
        payload: { reason: "User stopped the turn." },
      }),
      event(4, "turn.interrupted", {
        payload: {
          outcome: { status: "interrupted", reason: "User stopped the turn." },
        },
      }),
    ]);

    expect(projection.items[0]).toMatchObject({
      itemId: "itm_read01",
      status: "interrupted",
      completedAt: "2026-07-27T10:00:03.000Z",
    });
  });

  it("keeps context, usage and compaction identical across replay and continuation", () => {
    const events = [
      event(1, "context_budget.updated", {
        payload: {
          snapshot: {
            providerId: "openai",
            modelId: "gpt-5",
            contextWindowLimit: 100,
            systemTokens: 10,
            conversationTokens: 50,
            toolDefinitionTokens: 5,
            attachmentTokens: null,
            repositoryContextTokens: null,
            reservedOutputTokens: 20,
            safetyReserveTokens: 10,
            effectiveInputBudget: 70,
            tokensUsed: 65,
            tokensRemaining: 5,
            utilizationPercent: 92.85,
            warningThresholdPercent: 70,
            automaticCompactionThresholdPercent: 80,
            measurementSource: "tokenizer",
          },
        },
      }),
      event(2, "usage.updated", {
        payload: {
          usage: {
            providerId: "openai",
            modelId: "gpt-5",
            inputTokens: 65,
            outputTokens: 8,
            cachedInputTokens: 10,
            reasoningTokens: 2,
            totalTokens: 73,
            currentTurnCost: 0.02,
            cumulativeThreadTokens: 73,
            cumulativeThreadCost: 0.02,
            currency: "USD",
            measurementSource: "provider",
          },
        },
      }),
      event(3, "context_compaction.requested", {
        itemId: "itm_context01",
        payload: {
          compactionId: "cmp_context01",
          itemId: "itm_context01",
          mode: "manual",
          phase: "requested",
          preservedContextReference: null,
          summary: null,
          error: null,
        },
      }),
      event(4, "context_compaction.completed", {
        itemId: "itm_context01",
        payload: {
          compactionId: "cmp_context01",
          itemId: "itm_context01",
          mode: "manual",
          phase: "compacted",
          preservedContextReference: "context:trn_workflow01:compacted",
          summary: "Preserved request.",
          error: null,
        },
      }),
    ];
    const full = replayTurnWorkflowProjection(TURN_ID, events);
    const incremental = events.reduce(
      applyLifecycleEvent,
      createTurnWorkflowProjection(TURN_ID),
    );
    expect(incremental).toEqual(full);
    expect(full.contextBudget?.tokensUsed).toBe(65);
    expect(full.usage?.cumulativeThreadTokens).toBe(73);
    expect(full.items.at(-1)).toMatchObject({
      kind: "context_compaction",
      compactionPhase: "compacted",
      status: "completed",
    });
    const compactionSegment = groupToolActivity(full.items).at(-1);
    expect(buildSegmentTitle(compactionSegment!)).toBe("compacted context");
  });
});

function toolStarted(
  sequence: number,
  itemId: string,
  toolCallId: string,
  family:
    | "read"
    | "search"
    | "shell"
    | "edit"
    | "git"
    | "web"
    | "image"
    | "skill"
    | "browser"
    | "mcp"
    | "dynamic"
    | "generic",
  detail: string,
): LifecycleEvent {
  return event(sequence, "tool_call.started", {
    itemId,
    toolCallId,
    payload: {
      display: {
        family,
        namespace: "filesystem",
        title: "Read File",
        inputSummary: detail,
      },
    },
  });
}

function toolCompleted(
  sequence: number,
  itemId: string,
  toolCallId: string,
): LifecycleEvent {
  return event(sequence, "tool_call.completed", {
    itemId,
    toolCallId,
    payload: { result: { ok: true } },
  });
}

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  fields: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_workflow${sequence}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    runAttemptId: ATTEMPT_ID,
    sequence,
    idempotencyKey: `${TURN_ID}:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "workflow-test" },
    schemaVersion: 1,
    createdAt: `2026-07-27T10:00:0${sequence}.000Z`,
    type,
    ...fields,
  });
}
