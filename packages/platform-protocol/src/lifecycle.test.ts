import { describe, expect, it } from "vitest";
import {
  ApprovalStatusSchema,
  ApprovalLifecycleSchema,
  ItemLifecycleSchema,
  ItemStatusSchema,
  LifecycleEventSchema,
  LifecycleTransitionError,
  RunAttemptStatusSchema,
  RunAttemptLifecycleSchema,
  ToolCallStatusSchema,
  TurnStatusSchema,
  TurnLifecycleSchema,
  assertNextLifecycleSequence,
  assertTurnAcceptsLifecycleEvent,
  transitionApprovalStatus,
  transitionItemStatus,
  transitionRunAttemptStatus,
  transitionToolCallStatus,
  transitionTurnStatus,
  validateTerminalSettlement,
  type ApprovalStatus,
  type ItemStatus,
  type RunAttemptStatus,
  type ToolCallStatus,
  type TurnStatus,
} from "./lifecycle.js";
import { ApprovalIdSchema, ItemIdSchema } from "./ids.js";

const LEGAL_TURN_TRANSITIONS: ReadonlyArray<readonly [TurnStatus, TurnStatus]> =
  [
    ["queued", "in_progress"],
    ["queued", "interrupted"],
    ["queued", "failed"],
    ["in_progress", "in_progress"],
    ["in_progress", "completed"],
    ["in_progress", "interrupted"],
    ["in_progress", "failed"],
  ];

const LEGAL_RUN_ATTEMPT_TRANSITIONS: ReadonlyArray<
  readonly [RunAttemptStatus, RunAttemptStatus]
> = [
  ["queued", "running"],
  ["queued", "interrupted"],
  ["queued", "failed"],
  ["running", "succeeded"],
  ["running", "interrupted"],
  ["running", "failed"],
];

const LEGAL_ITEM_TRANSITIONS: ReadonlyArray<readonly [ItemStatus, ItemStatus]> =
  [
    ["not_started", "active"],
    ["active", "completed"],
    ["active", "failed"],
    ["active", "declined"],
    ["active", "interrupted"],
  ];

const LEGAL_TOOL_CALL_TRANSITIONS: ReadonlyArray<
  readonly [ToolCallStatus, ToolCallStatus]
> = LEGAL_ITEM_TRANSITIONS;

const LEGAL_APPROVAL_TRANSITIONS: ReadonlyArray<
  readonly [ApprovalStatus, ApprovalStatus]
> = [
  ["pending", "approved"],
  ["pending", "denied"],
  ["pending", "cancelled"],
];

describe("canonical lifecycle transition authority", () => {
  it("accepts every legal transition", () => {
    for (const [from, to] of LEGAL_TURN_TRANSITIONS) {
      expect(transitionTurnStatus(from, to)).toBe(to);
    }
    for (const [from, to] of LEGAL_RUN_ATTEMPT_TRANSITIONS) {
      expect(transitionRunAttemptStatus(from, to)).toBe(to);
    }
    for (const [from, to] of LEGAL_ITEM_TRANSITIONS) {
      expect(transitionItemStatus(from, to)).toBe(to);
    }
    for (const [from, to] of LEGAL_TOOL_CALL_TRANSITIONS) {
      expect(transitionToolCallStatus(from, to)).toBe(to);
    }
    for (const [from, to] of LEGAL_APPROVAL_TRANSITIONS) {
      expect(transitionApprovalStatus(from, to)).toBe(to);
    }
  });

  it("rejects every transition outside the legal matrices with a typed error", () => {
    expectIllegalTransitions(
      TurnStatusSchema.options,
      LEGAL_TURN_TRANSITIONS,
      transitionTurnStatus,
    );
    expectIllegalTransitions(
      RunAttemptStatusSchema.options,
      LEGAL_RUN_ATTEMPT_TRANSITIONS,
      transitionRunAttemptStatus,
    );
    expectIllegalTransitions(
      ItemStatusSchema.options,
      LEGAL_ITEM_TRANSITIONS,
      transitionItemStatus,
    );
    expectIllegalTransitions(
      ToolCallStatusSchema.options,
      LEGAL_TOOL_CALL_TRANSITIONS,
      transitionToolCallStatus,
    );
    expectIllegalTransitions(
      ApprovalStatusSchema.options,
      LEGAL_APPROVAL_TRANSITIONS,
      transitionApprovalStatus,
    );
  });

  it("keeps approval waiting separate from failure and terminal status", () => {
    expect(() =>
      validateTerminalSettlement({
        turnStatus: "in_progress",
        terminalOutcome: null,
        blockingState: {
          kind: "waiting_for_approval",
          itemId: ItemIdSchema.parse("itm_abc123"),
          approvalId: ApprovalIdSchema.parse("appr_abc123"),
        },
        itemStatuses: { itm_abc123: "active" },
        approvalStatuses: { appr_abc123: "pending" },
      }),
    ).toThrow(LifecycleTransitionError);
    expect(TurnStatusSchema.options).not.toContain("waiting_for_approval");
    expect(TurnStatusSchema.options).not.toContain("cancelled");
  });

  it("requires explicit, matching, exactly settled terminal state", () => {
    expect(() =>
      validateTerminalSettlement({
        turnStatus: "completed",
        terminalOutcome: { status: "completed" },
        blockingState: { kind: "none" },
        itemStatuses: {
          itm_message1: "completed",
          itm_toolcall1: "completed",
        },
        approvalStatuses: { appr_request1: "approved" },
      }),
    ).not.toThrow();

    expectSettlementFailure({
      terminalOutcome: null,
    });
    expectSettlementFailure({
      terminalOutcome: { status: "interrupted", reason: "User stopped turn." },
    });
    expectSettlementFailure({
      blockingState: {
        kind: "waiting_for_approval",
        itemId: ItemIdSchema.parse("itm_toolcall1"),
        approvalId: ApprovalIdSchema.parse("appr_request1"),
      },
    });
    expectSettlementFailure({
      itemStatuses: { itm_toolcall1: "active" },
    });
    expectSettlementFailure({
      approvalStatuses: { appr_request1: "pending" },
    });
  });

  it("rejects events after terminal settlement and non-contiguous sequence", () => {
    expect(() =>
      assertTurnAcceptsLifecycleEvent("completed", "item.started"),
    ).toThrow(LifecycleTransitionError);
    expect(() => assertNextLifecycleSequence({ lastSequence: 5 }, 7)).toThrow(
      LifecycleTransitionError,
    );
    expect(() =>
      assertNextLifecycleSequence({ lastSequence: 5 }, 6),
    ).not.toThrow();
  });
});

describe("canonical lifecycle domain contracts", () => {
  const timestamp = "2026-06-15T00:00:00.000Z";

  it("requires terminal timestamps and outcomes to be unambiguous", () => {
    expect(
      TurnLifecycleSchema.parse({
        turnId: "trn_abc123",
        threadId: "thr_abc123",
        workspaceId: "wrk_abc123",
        activeRunAttemptId: "attempt_abc123",
        status: "completed",
        blockingState: { kind: "none" },
        startedAt: timestamp,
        completedAt: timestamp,
        terminalOutcome: { status: "completed" },
        lastSequence: 8,
      }),
    ).toMatchObject({ status: "completed", completedAt: timestamp });

    expect(() =>
      TurnLifecycleSchema.parse({
        turnId: "trn_abc123",
        threadId: "thr_abc123",
        workspaceId: "wrk_abc123",
        activeRunAttemptId: "attempt_abc123",
        status: "completed",
        blockingState: { kind: "none" },
        startedAt: timestamp,
        completedAt: null,
        terminalOutcome: null,
        lastSequence: 8,
      }),
    ).toThrow();
  });

  it("requires failed attempts to carry failure and all settled items to carry time", () => {
    expect(() =>
      RunAttemptLifecycleSchema.parse({
        runAttemptId: "attempt_abc123",
        turnId: "trn_abc123",
        status: "failed",
        startedAt: timestamp,
        completedAt: timestamp,
        failure: null,
      }),
    ).toThrow();
    expect(() =>
      ItemLifecycleSchema.parse({
        itemId: "itm_abc123",
        turnId: "trn_abc123",
        runAttemptId: "attempt_abc123",
        kind: "assistant_message",
        status: "completed",
        startedAt: timestamp,
        completedAt: null,
      }),
    ).toThrow();
  });

  it("requires approval decisions to be explicitly settled", () => {
    expect(() =>
      ApprovalLifecycleSchema.parse({
        approvalId: "appr_abc123",
        itemId: "itm_abc123",
        turnId: "trn_abc123",
        threadId: "thr_abc123",
        status: "approved",
        requestedAt: timestamp,
        decidedAt: null,
      }),
    ).toThrow();
  });
});

describe("canonical lifecycle event identifiers", () => {
  const envelope = {
    eventId: "evt_abc123",
    threadId: "thr_abc123",
    turnId: "trn_abc123",
    runAttemptId: "attempt_abc123",
    sequence: 1,
    idempotencyKey: "turn:1",
    producer: { kind: "runtime_kernel", id: "kernel" },
    schemaVersion: 1,
    createdAt: "2026-06-15T00:00:00.000Z",
  } as const;

  it("requires turn and run-attempt identity on every lifecycle event", () => {
    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        type: "turn.started",
        payload: {},
      }),
    ).toMatchObject({
      turnId: "trn_abc123",
      runAttemptId: "attempt_abc123",
    });

    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        runAttemptId: undefined,
        type: "turn.started",
        payload: {},
      }),
    ).toThrow();
  });

  it("requires item, tool-call, and approval identifiers where applicable", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        type: "item.started",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        type: "tool_call.completed",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        type: "tool_call.output_delta",
        payload: { delta: "output" },
      }),
    ).toThrow();
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        type: "approval.requested",
        payload: {},
      }),
    ).toThrow();

    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        toolCallId: "toolcall_abc123",
        type: "tool_call.completed",
        payload: { result: { exitCode: 0 } },
      }),
    ).toMatchObject({ toolCallId: "toolcall_abc123" });
    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        toolCallId: "toolcall_abc123",
        type: "tool_call.output_delta",
        payload: { delta: "output" },
      }),
    ).toMatchObject({ toolCallId: "toolcall_abc123" });
    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        approvalId: "appr_abc123",
        type: "approval.requested",
        payload: {},
      }),
    ).toMatchObject({ approvalId: "appr_abc123" });
  });

  it("requires explicit terminal outcomes in terminal turn events", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        type: "turn.completed",
        payload: {},
      }),
    ).toThrow();
    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        type: "turn.interrupted",
        payload: {
          outcome: { status: "interrupted", reason: "User stopped turn." },
        },
      }),
    ).toMatchObject({ type: "turn.interrupted" });
  });

  it("requires authoritative item settlement payloads and request identity", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        type: "item.completed",
        payload: {},
      }),
    ).toThrow();
    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        type: "item.completed",
        payload: { result: { text: "Done." } },
      }),
    ).toMatchObject({ type: "item.completed" });
    expect(() =>
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        type: "user_input.requested",
        payload: {},
      }),
    ).toThrow();
    expect(
      LifecycleEventSchema.parse({
        ...envelope,
        itemId: "itm_abc123",
        requestId: "request_abc123",
        type: "user_input.requested",
        payload: {},
      }),
    ).toMatchObject({ requestId: "request_abc123" });
  });
});

function expectIllegalTransitions<TState extends string>(
  states: readonly TState[],
  legal: ReadonlyArray<readonly [TState, TState]>,
  transition: (from: TState, to: TState) => TState,
): void {
  const legalKeys = new Set(legal.map(([from, to]) => `${from}:${to}`));
  for (const from of states) {
    for (const to of states) {
      if (!legalKeys.has(`${from}:${to}`)) {
        expect(() => transition(from, to)).toThrow(LifecycleTransitionError);
      }
    }
  }
}

function expectSettlementFailure(
  override: Partial<Parameters<typeof validateTerminalSettlement>[0]>,
): void {
  expect(() =>
    validateTerminalSettlement({
      turnStatus: "completed",
      terminalOutcome: { status: "completed" },
      blockingState: { kind: "none" },
      itemStatuses: { itm_toolcall1: "completed" },
      approvalStatuses: { appr_request1: "approved" },
      ...override,
    }),
  ).toThrow(LifecycleTransitionError);
}
