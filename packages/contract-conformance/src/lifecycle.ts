import {
  ApprovalStatusSchema,
  ItemKindSchema,
  LifecycleEventSchema,
  LifecycleTransitionError,
  ToolCallStatusSchema,
  TurnBlockingStateSchema,
  assertNextLifecycleSequence,
  assertTurnAcceptsLifecycleEvent,
  isTerminalItemStatus,
  transitionApprovalStatus,
  transitionItemStatus,
  transitionRunAttemptStatus,
  transitionToolCallStatus,
  transitionTurnStatus,
  validateTerminalSettlement,
  type ApprovalStatus,
  type ItemKind,
  type ItemStatus,
  type LifecycleEvent,
  type RunAttemptStatus,
  type ToolCallStatus,
  type TurnBlockingState,
  type TurnStatus,
  type TurnTerminalOutcome,
} from "@repo/platform-protocol/lifecycle";
import type { ProtocolError } from "@repo/platform-protocol/errors";
import type { ThreadId, TurnId } from "@repo/platform-protocol/ids";
import { describe, expect, it } from "vitest";
import { z } from "zod";

interface LifecycleReplayResult {
  readonly events: readonly LifecycleEvent[];
  readonly nextSequence: number | null;
}

export interface LifecycleEventLogContract {
  appendBatch(events: readonly LifecycleEvent[]): Promise<readonly LifecycleEvent[]>;
  replay(input: {
    afterSequence: number | null;
    limit: number;
  }): Promise<LifecycleReplayResult>;
}

interface LifecycleFixture {
  readonly name: string;
  readonly events: readonly LifecycleEvent[];
}

type RequestStatus = "pending" | "resolved";

interface ReplayState {
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly status: TurnStatus;
  readonly blockingState: TurnBlockingState;
  readonly terminalOutcome: TurnTerminalOutcome | null;
  readonly runAttempts: Readonly<Record<string, RunAttemptStatus>>;
  readonly items: Readonly<Record<string, ItemStatus>>;
  readonly toolCalls: Readonly<Record<string, ToolCallStatus>>;
  readonly approvals: Readonly<Record<string, ApprovalStatus>>;
  readonly lastSequence: number;
  readonly accepted: boolean;
  readonly started: boolean;
  readonly terminalEvents: number;
  readonly itemKinds: Readonly<Record<string, ItemKind>>;
  readonly toolCallItems: Readonly<Record<string, string>>;
  readonly requests: Readonly<Record<string, RequestStatus>>;
}

const timestamp = "2026-06-17T00:00:00.000Z";
const ids = {
  threadId: "thr_lifecycle001",
  turnId: "trn_lifecycle001",
  runAttemptId: "attempt_lifecycle001",
  workspaceId: "wrk_lifecycle001",
  reasoningItemId: "itm_reasoning001",
  assistantItemId: "itm_assistant001",
  toolItemId: "itm_toolcall001",
  toolCallId: "toolcall_lifecycle001",
  approvalItemId: "itm_approval001",
  approvalId: "appr_lifecycle001",
  inputItemId: "itm_inputreq001",
  requestId: "request_lifecycle001",
} as const;

const ItemStartedPayloadSchema = z
  .object({ kind: ItemKindSchema })
  .passthrough();
const ApprovalDecisionPayloadSchema = z
  .object({ status: ApprovalStatusSchema.exclude(["pending"]) })
  .passthrough();
const BlockingChangedPayloadSchema = z
  .object({ blockingState: TurnBlockingStateSchema })
  .passthrough();

export function registerLifecycleSettlementConformance(
  implementation: string,
  createLog: () => LifecycleEventLogContract | Promise<LifecycleEventLogContract>,
): void {
  describe(`${implementation} lifecycle settlement conformance`, () => {
    for (const fixture of createLegalLifecycleFixtures()) {
      it(`replays legal fixture deterministically: ${fixture.name}`, async () => {
        const log = await createLog();
        await log.appendBatch(fixture.events);

        const fullReplay = await log.replay({ afterSequence: null, limit: 100 });
        const cursorReplay = await log.replay({
          afterSequence: fixture.events[0]?.sequence ?? null,
          limit: 100,
        });

        expect(fullReplay.events).toEqual(fixture.events);
        expect(cursorReplay.events).toEqual(fixture.events.slice(1));
        expect(replayLifecycleEvents(fullReplay.events).terminalEvents).toBe(1);
      });
    }

    for (const fixture of createIllegalLifecycleFixtures()) {
      it(`rejects illegal fixture: ${fixture.name}`, async () => {
        const log = await createLog();
        await log.appendBatch(fixture.events);

        const replay = await log.replay({ afterSequence: null, limit: 100 });

        expect(() => replayLifecycleEvents(replay.events)).toThrow(
          LifecycleTransitionError,
        );
      });
    }
  });
}

export function replayLifecycleEvents(
  events: readonly LifecycleEvent[],
): ReplayState {
  const state = events.reduce(applyLifecycleEvent, createInitialState());
  assertAcceptedTurnSettled(state);
  return state;
}

function applyLifecycleEvent(state: ReplayState, event: LifecycleEvent): ReplayState {
  assertNextLifecycleSequence(state, event.sequence);
  const scopedState = bindReplayScope(state, event);
  if (scopedState.terminalEvents > 0) {
    assertTurnAcceptsLifecycleEvent(scopedState.status, event.type);
  }

  const next =
    applyTurnEvent(scopedState, event) ??
    applyRunAttemptEvent(scopedState, event) ??
    applyItemEvent(scopedState, event) ??
    applyToolCallEvent(scopedState, event) ??
    applyApprovalEvent(scopedState, event) ??
    applyRequestEvent(scopedState, event);
  return next ?? advance(scopedState, event.sequence);
}

function bindReplayScope(state: ReplayState, event: LifecycleEvent): ReplayState {
  if (state.turnId === null) {
    return {
      ...state,
      threadId: event.threadId,
      turnId: event.turnId,
    };
  }
  assertMatchingScope("threadId", state.threadId, event.threadId);
  assertMatchingScope("turnId", state.turnId, event.turnId);
  return state;
}

function assertMatchingScope(
  label: "threadId" | "turnId",
  current: string | null,
  next: string,
): void {
  if (current !== next) {
    throwTransition("turn", current ?? "missing", next, `${label} changed within lifecycle replay`);
  }
}

function applyTurnEvent(
  state: ReplayState,
  event: LifecycleEvent,
): ReplayState | null {
  switch (event.type) {
    case "turn.queued":
      return applyTurnQueued(state);
    case "turn.started":
      return applyTurnStarted(state);
    case "turn.blocking_changed":
      return applyBlockingChanged(state, event.payload);
    case "turn.completed":
      return applyTerminalTurn(state, "completed", event.payload.outcome);
    case "turn.interrupted":
      return applyTerminalTurn(state, "interrupted", event.payload.outcome);
    case "turn.failed":
      return applyTerminalTurn(state, "failed", event.payload.outcome);
    default:
      return null;
  }
}

function applyRunAttemptEvent(
  state: ReplayState,
  event: LifecycleEvent,
): ReplayState | null {
  switch (event.type) {
    case "run_attempt.started":
      return setRunAttemptStatus(state, event.runAttemptId, "running");
    case "run_attempt.succeeded":
      return setRunAttemptStatus(state, event.runAttemptId, "succeeded");
    case "run_attempt.interrupted":
      return setRunAttemptStatus(state, event.runAttemptId, "interrupted");
    case "run_attempt.failed":
      return setRunAttemptStatus(state, event.runAttemptId, "failed");
    default:
      return null;
  }
}

function applyItemEvent(
  state: ReplayState,
  event: LifecycleEvent,
): ReplayState | null {
  switch (event.type) {
    case "item.started":
      return applyItemStarted(state, event.itemId, event.payload);
    case "item.updated":
      return requireActiveItem(state, event.itemId, event.sequence);
    case "reasoning.summary_delta":
      return requireActiveItemKind(state, event.itemId, "reasoning", event.sequence);
    case "assistant_message.delta":
      return requireActiveItemKind(
        state,
        event.itemId,
        "assistant_message",
        event.sequence,
      );
    case "plan.updated":
      return requireActiveItemKind(state, event.itemId, "plan", event.sequence);
    case "command_execution.output_delta":
      return requireActiveItemKind(
        state,
        event.itemId,
        "command_execution",
        event.sequence,
      );
    case "file_change.patch_updated":
      return requireActiveItemKind(state, event.itemId, "file_change", event.sequence);
    case "tool_call.started":
    case "tool_call.input_delta":
    case "tool_call.output_delta":
    case "tool_call.completed":
    case "tool_call.failed":
    case "tool_call.declined":
    case "tool_call.interrupted":
      return null;
    case "item.completed":
      return setItemStatus(state, event.itemId, "completed");
    case "item.failed":
      return setItemStatus(state, event.itemId, "failed");
    case "item.declined":
      return setItemStatus(state, event.itemId, "declined");
    case "item.interrupted":
      return setItemStatus(state, event.itemId, "interrupted");
    default:
      return null;
  }
}

function applyToolCallEvent(
  state: ReplayState,
  event: LifecycleEvent,
): ReplayState | null {
  switch (event.type) {
    case "tool_call.started":
      return applyToolCallStarted(state, event.itemId, event.toolCallId);
    case "tool_call.input_delta":
    case "tool_call.output_delta":
      return requireActiveToolCall(state, event.toolCallId, event.sequence);
    case "tool_call.completed":
      return setToolCallStatus(state, event.toolCallId, "completed");
    case "tool_call.failed":
      return setToolCallStatus(state, event.toolCallId, "failed");
    case "tool_call.declined":
      return setToolCallStatus(state, event.toolCallId, "declined");
    case "tool_call.interrupted":
      return setToolCallStatus(state, event.toolCallId, "interrupted");
    default:
      return null;
  }
}

function applyApprovalEvent(
  state: ReplayState,
  event: LifecycleEvent,
): ReplayState | null {
  switch (event.type) {
    case "approval.requested":
      return applyApprovalRequested(state, event.itemId, event.approvalId);
    case "approval.decided":
      return applyApprovalDecided(state, event.approvalId, event.payload);
    default:
      return null;
  }
}

function applyRequestEvent(
  state: ReplayState,
  event: LifecycleEvent,
): ReplayState | null {
  switch (event.type) {
    case "user_input.requested":
      return applyUserInputRequested(state, event.itemId, event.requestId);
    case "user_input.responded":
      return requirePendingRequest(state, event.requestId, event.sequence);
    case "request.resolved":
      return setRequestResolved(state, event.requestId);
    default:
      return null;
  }
}

function createInitialState(): ReplayState {
  return {
    threadId: null,
    turnId: null,
    status: "queued",
    blockingState: { kind: "none" },
    terminalOutcome: null,
    runAttempts: {},
    items: {},
    toolCalls: {},
    approvals: {},
    lastSequence: 0,
    accepted: false,
    started: false,
    terminalEvents: 0,
    itemKinds: {},
    toolCallItems: {},
    requests: {},
  };
}

function applyTurnQueued(state: ReplayState): ReplayState {
  if (state.accepted) {
    throwTransition("turn", "queued", "turn.queued", "turn accepted twice");
  }
  return { ...advance(state, state.lastSequence + 1), accepted: true };
}

function applyTurnStarted(state: ReplayState): ReplayState {
  requireAccepted(state);
  if (state.started) {
    throwTransition("turn", state.status, "turn.started", "turn started twice");
  }
  return {
    ...advance(state, state.lastSequence + 1),
    started: true,
    status: transitionTurnStatus(state.status, "in_progress"),
  };
}

function applyBlockingChanged(
  state: ReplayState,
  payload: Record<string, unknown>,
): ReplayState {
  requireStarted(state);
  const parsed = BlockingChangedPayloadSchema.parse(payload);
  return {
    ...advance(state, state.lastSequence + 1),
    blockingState: parsed.blockingState,
  };
}

function applyItemStarted(
  state: ReplayState,
  itemId: string,
  payload: Record<string, unknown>,
): ReplayState {
  requireStarted(state);
  const parsed = ItemStartedPayloadSchema.parse(payload);
  return {
    ...setItemStatus(state, itemId, "active"),
    itemKinds: { ...state.itemKinds, [itemId]: parsed.kind },
  };
}

function applyToolCallStarted(
  state: ReplayState,
  itemId: string,
  toolCallId: string,
): ReplayState {
  requireActiveItemKind(state, itemId, "tool_call", state.lastSequence + 1);
  return {
    ...setToolCallStatus(state, toolCallId, "active"),
    toolCallItems: { ...state.toolCallItems, [toolCallId]: itemId },
  };
}

function applyApprovalRequested(
  state: ReplayState,
  itemId: string,
  approvalId: string,
): ReplayState {
  requireActiveItemKind(state, itemId, "approval_request", state.lastSequence + 1);
  return {
    ...advance(state, state.lastSequence + 1),
    approvals: { ...state.approvals, [approvalId]: "pending" },
  };
}

function applyApprovalDecided(
  state: ReplayState,
  approvalId: string,
  payload: Record<string, unknown>,
): ReplayState {
  const status = ApprovalDecisionPayloadSchema.parse(payload).status;
  return setApprovalStatus(state, approvalId, status);
}

function applyUserInputRequested(
  state: ReplayState,
  itemId: string,
  requestId: string,
): ReplayState {
  requireActiveItemKind(state, itemId, "user_input_request", state.lastSequence + 1);
  return {
    ...advance(state, state.lastSequence + 1),
    requests: { ...state.requests, [requestId]: "pending" },
  };
}

function applyTerminalTurn(
  state: ReplayState,
  status: TurnStatus,
  outcome: TurnTerminalOutcome,
): ReplayState {
  requireStarted(state);
  const next = {
    ...advance(state, state.lastSequence + 1),
    status: transitionTurnStatus(state.status, status),
    terminalOutcome: outcome,
    terminalEvents: state.terminalEvents + 1,
  };
  assertTerminalSettlement(next);
  return next;
}

function setRunAttemptStatus(
  state: ReplayState,
  runAttemptId: string,
  status: RunAttemptStatus,
): ReplayState {
  const from = state.runAttempts[runAttemptId] ?? "queued";
  return {
    ...advance(state, state.lastSequence + 1),
    runAttempts: {
      ...state.runAttempts,
      [runAttemptId]: transitionRunAttemptStatus(from, status),
    },
  };
}

function setItemStatus(
  state: ReplayState,
  itemId: string,
  status: ItemStatus,
): ReplayState {
  const from = state.items[itemId] ?? "not_started";
  const next = {
    ...advance(state, state.lastSequence + 1),
    items: { ...state.items, [itemId]: transitionItemStatus(from, status) },
  };
  assertToolItemSettled(next, itemId, status);
  return next;
}

function setToolCallStatus(
  state: ReplayState,
  toolCallId: string,
  status: ToolCallStatus,
): ReplayState {
  const from = state.toolCalls[toolCallId] ?? "not_started";
  return {
    ...advance(state, state.lastSequence + 1),
    toolCalls: {
      ...state.toolCalls,
      [toolCallId]: transitionToolCallStatus(from, status),
    },
  };
}

function setApprovalStatus(
  state: ReplayState,
  approvalId: string,
  status: ApprovalStatus,
): ReplayState {
  const from = state.approvals[approvalId] ?? "pending";
  return {
    ...advance(state, state.lastSequence + 1),
    approvals: {
      ...state.approvals,
      [approvalId]: transitionApprovalStatus(from, status),
    },
  };
}

function setRequestResolved(state: ReplayState, requestId: string): ReplayState {
  requirePendingRequest(state, requestId, state.lastSequence + 1);
  return {
    ...advance(state, state.lastSequence + 1),
    requests: { ...state.requests, [requestId]: "resolved" },
  };
}

function requireActiveItem(
  state: ReplayState,
  itemId: string,
  sequence: number,
): ReplayState {
  if (state.items[itemId] !== "active") {
    throwTransition("item", state.items[itemId] ?? "missing", "active", "item is not active");
  }
  return advance(state, sequence);
}

function requireActiveItemKind(
  state: ReplayState,
  itemId: string,
  kind: ItemKind,
  sequence: number,
): ReplayState {
  requireActiveItem(state, itemId, sequence);
  if (state.itemKinds[itemId] !== kind) {
    throwTransition("item", state.itemKinds[itemId] ?? "missing", kind, "item kind mismatch");
  }
  return advance(state, sequence);
}

function requireActiveToolCall(
  state: ReplayState,
  toolCallId: string,
  sequence: number,
): ReplayState {
  if (state.toolCalls[toolCallId] !== "active") {
    throwTransition(
      "tool_call",
      state.toolCalls[toolCallId] ?? "missing",
      "active",
      "tool call is not active",
    );
  }
  return advance(state, sequence);
}

function requirePendingRequest(
  state: ReplayState,
  requestId: string,
  sequence: number,
): ReplayState {
  if (state.requests[requestId] !== "pending") {
    throwTransition("turn", state.requests[requestId] ?? "missing", requestId, "request is not pending");
  }
  return advance(state, sequence);
}

function requireAccepted(state: ReplayState): void {
  if (!state.accepted) {
    throwTransition("turn", "missing", "accepted", "turn was not accepted");
  }
}

function requireStarted(state: ReplayState): void {
  requireAccepted(state);
  if (!state.started) {
    throwTransition("turn", state.status, "in_progress", "turn has not started");
  }
}

function assertAcceptedTurnSettled(state: ReplayState): void {
  if (!state.accepted || state.terminalEvents !== 1) {
    throwTransition("turn", String(state.terminalEvents), "1", "accepted turn must settle exactly once");
  }
  assertTerminalSettlement(state);
}

function assertTerminalSettlement(state: ReplayState): void {
  validateTerminalSettlement({
    turnStatus: state.status,
    terminalOutcome: state.terminalOutcome,
    blockingState: state.blockingState,
    itemStatuses: state.items,
    approvalStatuses: state.approvals,
  });
  assertNoActiveRunAttempts(state);
  assertNoActiveToolCalls(state);
  assertNoPendingRequests(state);
}

function assertNoActiveRunAttempts(state: ReplayState): void {
  for (const [runAttemptId, status] of Object.entries(state.runAttempts)) {
    if (status === "queued" || status === "running") {
      throwTransition("run_attempt", status, "terminal", `${runAttemptId} remains active`);
    }
  }
}

function assertNoActiveToolCalls(state: ReplayState): void {
  for (const [toolCallId, status] of Object.entries(state.toolCalls)) {
    if (!ToolCallStatusSchema.exclude(["not_started", "active"]).safeParse(status).success) {
      throwTransition("tool_call", status, "terminal", `${toolCallId} remains active`);
    }
  }
}

function assertNoPendingRequests(state: ReplayState): void {
  for (const [requestId, status] of Object.entries(state.requests)) {
    if (status === "pending") {
      throwTransition("turn", status, "resolved", `${requestId} remains pending`);
    }
  }
}

function assertToolItemSettled(
  state: ReplayState,
  itemId: string,
  status: ItemStatus,
): void {
  if (state.itemKinds[itemId] !== "tool_call" || !isTerminalItemStatus(status)) {
    return;
  }
  const toolCalls = Object.entries(state.toolCallItems).filter(
    ([, parentItemId]) => parentItemId === itemId,
  );
  if (toolCalls.length === 0) {
    throwTransition("tool_call", "missing", "terminal", "tool item has no tool call");
  }
  for (const [toolCallId] of toolCalls) {
    if (state.toolCalls[toolCallId] === "active") {
      throwTransition("tool_call", "active", "terminal", `${toolCallId} remains active`);
    }
  }
}

function advance(state: ReplayState, sequence: number): ReplayState {
  return { ...state, lastSequence: sequence };
}

function throwTransition(
  subject: ConstructorParameters<typeof LifecycleTransitionError>[0],
  from: string,
  to: string,
  reason: string,
): never {
  throw new LifecycleTransitionError(subject, from, to, reason);
}

function createLegalLifecycleFixtures(): readonly LifecycleFixture[] {
  return [
    { name: "reasoning and final message complete", events: completedTurnEvents() },
    { name: "approval wait resolves without failure", events: approvalTurnEvents() },
    { name: "tool call settles before item and turn", events: toolTurnEvents() },
    { name: "user input request resolves before completion", events: userInputTurnEvents() },
    { name: "interruption settles explicitly", events: interruptedTurnEvents() },
    { name: "failure settles explicitly", events: failedTurnEvents() },
  ];
}

function createIllegalLifecycleFixtures(): readonly LifecycleFixture[] {
  return [
    { name: "terminal turn with active item", events: terminalWithActiveItemEvents() },
    { name: "terminal turn with pending approval", events: terminalWithPendingApprovalEvents() },
    { name: "terminal turn with active tool call", events: terminalWithActiveToolEvents() },
    { name: "terminal turn with pending user request", events: terminalWithPendingRequestEvents() },
    { name: "event after terminal settlement", events: eventAfterTerminalEvents() },
    { name: "terminal settlement before start", events: terminalBeforeStartEvents() },
    { name: "non-contiguous event sequence", events: nonContiguousEvents() },
    { name: "reasoning delta attached to assistant item", events: mismatchedReasoningEvents() },
  ];
}

function completedTurnEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    event(3, "run_attempt.started"),
    itemStarted(4, ids.reasoningItemId, "reasoning"),
    itemEvent(5, "reasoning.summary_delta", ids.reasoningItemId),
    itemEvent(6, "item.completed", ids.reasoningItemId, { result: {} }),
    itemStarted(7, ids.assistantItemId, "assistant_message"),
    itemEvent(8, "assistant_message.delta", ids.assistantItemId),
    itemEvent(9, "item.completed", ids.assistantItemId, { result: {} }),
    event(10, "run_attempt.succeeded"),
    terminalEvent(11, "turn.completed", { status: "completed" }),
  ];
}

function approvalTurnEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    event(3, "run_attempt.started"),
    itemStarted(4, ids.approvalItemId, "approval_request"),
    approvalEvent(5, "approval.requested", { reason: "Run shell command." }),
    blockingChanged(6, {
      kind: "waiting_for_approval",
      itemId: ids.approvalItemId,
      approvalId: ids.approvalId,
    }),
    approvalEvent(7, "approval.decided", { status: "approved" }),
    blockingChanged(8, { kind: "none" }),
    itemEvent(9, "item.completed", ids.approvalItemId, { result: {} }),
    event(10, "run_attempt.succeeded"),
    terminalEvent(11, "turn.completed", { status: "completed" }),
  ];
}

function toolTurnEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    event(3, "run_attempt.started"),
    itemStarted(4, ids.toolItemId, "tool_call"),
    toolEvent(5, "tool_call.started", {}),
    toolEvent(6, "tool_call.input_delta", { input: "pnpm test" }),
    toolEvent(7, "tool_call.output_delta", { output: "ok" }),
    toolEvent(8, "tool_call.completed", { result: {} }),
    itemEvent(9, "item.completed", ids.toolItemId, { result: {} }),
    event(10, "run_attempt.succeeded"),
    terminalEvent(11, "turn.completed", { status: "completed" }),
  ];
}

function userInputTurnEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    event(3, "run_attempt.started"),
    itemStarted(4, ids.inputItemId, "user_input_request"),
    requestEvent(5, "user_input.requested", { prompt: "Choose model." }),
    blockingChanged(6, {
      kind: "waiting_for_user_input",
      itemId: ids.inputItemId,
      requestId: ids.requestId,
    }),
    requestEvent(7, "user_input.responded", { value: "default" }),
    requestEvent(8, "request.resolved", { status: "resolved" }),
    blockingChanged(9, { kind: "none" }),
    itemEvent(10, "item.completed", ids.inputItemId, { result: {} }),
    event(11, "run_attempt.succeeded"),
    terminalEvent(12, "turn.completed", { status: "completed" }),
  ];
}

function interruptedTurnEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    event(3, "run_attempt.started"),
    itemStarted(4, ids.reasoningItemId, "reasoning"),
    itemEvent(5, "item.interrupted", ids.reasoningItemId, { reason: "User stopped." }),
    event(6, "run_attempt.interrupted"),
    terminalEvent(7, "turn.interrupted", {
      status: "interrupted",
      reason: "User stopped.",
    }),
  ];
}

function failedTurnEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    event(3, "run_attempt.started"),
    itemStarted(4, ids.reasoningItemId, "reasoning"),
    itemEvent(5, "item.failed", ids.reasoningItemId, { failure: protocolFailure() }),
    event(6, "run_attempt.failed"),
    terminalEvent(7, "turn.failed", {
      status: "failed",
      failure: protocolFailure(),
    }),
  ];
}

function terminalWithActiveItemEvents(): readonly LifecycleEvent[] {
  return renumberEvents(
    completedTurnEvents().filter((event) => event.sequence !== 9),
  );
}

function terminalWithPendingApprovalEvents(): readonly LifecycleEvent[] {
  return [
    ...approvalTurnEvents().slice(0, 6),
    event(7, "run_attempt.succeeded"),
    terminalEvent(8, "turn.completed", { status: "completed" }),
  ];
}

function terminalWithActiveToolEvents(): readonly LifecycleEvent[] {
  return renumberEvents(toolTurnEvents().filter((event) => event.sequence !== 8));
}

function terminalWithPendingRequestEvents(): readonly LifecycleEvent[] {
  return [
    ...userInputTurnEvents().slice(0, 6),
    event(7, "run_attempt.succeeded"),
    terminalEvent(8, "turn.completed", { status: "completed" }),
  ];
}

function eventAfterTerminalEvents(): readonly LifecycleEvent[] {
  return [
    ...completedTurnEvents(),
    itemStarted(12, "itm_lateitem001", "assistant_message"),
  ];
}

function terminalBeforeStartEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    terminalEvent(2, "turn.completed", { status: "completed" }),
  ];
}

function nonContiguousEvents(): readonly LifecycleEvent[] {
  return [event(1, "turn.queued"), event(3, "turn.started")];
}

function mismatchedReasoningEvents(): readonly LifecycleEvent[] {
  return [
    event(1, "turn.queued"),
    event(2, "turn.started"),
    itemStarted(3, ids.assistantItemId, "assistant_message"),
    itemEvent(4, "reasoning.summary_delta", ids.assistantItemId),
  ];
}

function itemStarted(
  sequence: number,
  itemId: string,
  kind: ItemKind,
): LifecycleEvent {
  return itemEvent(sequence, "item.started", itemId, { kind });
}

function itemEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  itemId: string,
  payload: Record<string, unknown> = {},
): LifecycleEvent {
  return lifecycleEvent(sequence, type, { itemId, payload });
}

function toolEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  payload: Record<string, unknown>,
): LifecycleEvent {
  return lifecycleEvent(sequence, type, {
    itemId: ids.toolItemId,
    toolCallId: ids.toolCallId,
    payload,
  });
}

function approvalEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  payload: Record<string, unknown>,
): LifecycleEvent {
  return lifecycleEvent(sequence, type, {
    itemId: ids.approvalItemId,
    approvalId: ids.approvalId,
    payload,
  });
}

function requestEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  payload: Record<string, unknown>,
): LifecycleEvent {
  return lifecycleEvent(sequence, type, {
    itemId: ids.inputItemId,
    requestId: ids.requestId,
    payload,
  });
}

function blockingChanged(
  sequence: number,
  blockingState: Record<string, unknown>,
): LifecycleEvent {
  return event(sequence, "turn.blocking_changed", { blockingState });
}

function terminalEvent(
  sequence: number,
  type: "turn.completed" | "turn.interrupted" | "turn.failed",
  outcome: TurnTerminalOutcome,
): LifecycleEvent {
  return event(sequence, type, { outcome });
}

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  payload: Record<string, unknown> = {},
): LifecycleEvent {
  return lifecycleEvent(sequence, type, { payload });
}

function lifecycleEvent(
  sequence: number,
  type: LifecycleEvent["type"],
  extra: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_lifecycle${String(sequence).padStart(3, "0")}`,
    threadId: ids.threadId,
    turnId: ids.turnId,
    runAttemptId: ids.runAttemptId,
    sequence,
    idempotencyKey: `lifecycle:${sequence}`,
    producer: { kind: "runtime_kernel", id: "conformance" },
    schemaVersion: 1,
    createdAt: timestamp,
    type,
    ...extra,
  });
}

function renumberEvents(events: readonly LifecycleEvent[]): readonly LifecycleEvent[] {
  return events.map((event, index) => {
    const sequence = index + 1;
    return LifecycleEventSchema.parse({
      ...event,
      eventId: `evt_lifecycle${String(sequence).padStart(3, "0")}`,
      sequence,
      idempotencyKey: `lifecycle:${sequence}`,
    });
  });
}

function protocolFailure(): ProtocolError {
  return {
    code: "internal_error",
    message: "Runtime failed.",
    retryable: false,
    correlationId: null,
    details: null,
  };
}
