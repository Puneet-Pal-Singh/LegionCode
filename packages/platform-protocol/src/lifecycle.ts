import { z } from "zod";
import {
  EventSequenceSchema,
  JsonRecordSchema,
  ProtocolTimestampSchema,
} from "./common.js";
import { ProtocolErrorSchema, type ProtocolError } from "./errors.js";
import {
  ApprovalIdSchema,
  EventIdSchema,
  ItemIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
  type ApprovalId,
  type ItemId,
  type RunAttemptId,
  type ToolCallId,
  type TurnId,
} from "./ids.js";

// Version 1 exports only stable lifecycle fields; it has no experimental fields.
export const LIFECYCLE_SCHEMA_VERSION = 1;

export const TurnStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "interrupted",
  "failed",
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const TurnTerminalStatusSchema = z.enum([
  "completed",
  "interrupted",
  "failed",
]);
export type TurnTerminalStatus = z.infer<typeof TurnTerminalStatusSchema>;

export const TurnBlockingKindSchema = z.enum([
  "waiting_for_approval",
  "waiting_for_user_input",
  "retry_scheduled",
]);
export type TurnBlockingKind = z.infer<typeof TurnBlockingKindSchema>;

const UnblockedTurnStateSchema = z.object({ kind: z.literal("none") }).strict();
const ApprovalBlockingStateSchema = z
  .object({
    kind: z.literal("waiting_for_approval"),
    itemId: ItemIdSchema,
    approvalId: ApprovalIdSchema,
  })
  .strict();
const UserInputBlockingStateSchema = z
  .object({
    kind: z.literal("waiting_for_user_input"),
    itemId: ItemIdSchema,
    requestId: z.string().min(1).max(160),
  })
  .strict();
const RetryBlockingStateSchema = z
  .object({
    kind: z.literal("retry_scheduled"),
    runAttemptId: RunAttemptIdSchema,
  })
  .strict();

export const TurnBlockingStateSchema = z.discriminatedUnion("kind", [
  UnblockedTurnStateSchema,
  ApprovalBlockingStateSchema,
  UserInputBlockingStateSchema,
  RetryBlockingStateSchema,
]);
export type TurnBlockingState = z.infer<typeof TurnBlockingStateSchema>;

const CompletedTurnOutcomeSchema = z
  .object({ status: z.literal("completed") })
  .strict();
const InterruptedTurnOutcomeSchema = z
  .object({
    status: z.literal("interrupted"),
    reason: z.string().min(1).max(2_000),
  })
  .strict();
const FailedTurnOutcomeSchema = z
  .object({
    status: z.literal("failed"),
    failure: ProtocolErrorSchema,
  })
  .strict();

export const TurnTerminalOutcomeSchema = z.discriminatedUnion("status", [
  CompletedTurnOutcomeSchema,
  InterruptedTurnOutcomeSchema,
  FailedTurnOutcomeSchema,
]);
export type TurnTerminalOutcome = z.infer<typeof TurnTerminalOutcomeSchema>;

export const RunAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "interrupted",
  "failed",
]);
export type RunAttemptStatus = z.infer<typeof RunAttemptStatusSchema>;

export const ItemStatusSchema = z.enum([
  "not_started",
  "active",
  "completed",
  "failed",
  "declined",
  "interrupted",
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ToolCallStatusSchema = z.enum([
  "not_started",
  "active",
  "completed",
  "failed",
  "declined",
  "interrupted",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ItemKindSchema = z.enum([
  "user_message",
  "reasoning",
  "plan",
  "assistant_message",
  "tool_call",
  "command_execution",
  "file_change",
  "git_operation",
  "approval_request",
  "user_input_request",
  "artifact",
  "context_compaction",
  "warning",
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const TurnLifecycleSchema = z
  .object({
    turnId: TurnIdSchema,
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
    activeRunAttemptId: RunAttemptIdSchema.nullable(),
    status: TurnStatusSchema,
    blockingState: TurnBlockingStateSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
    terminalOutcome: TurnTerminalOutcomeSchema.nullable(),
    lastSequence: EventSequenceSchema,
  })
  .strict()
  .superRefine(validateTurnLifecycleShape);
export type TurnLifecycle = z.infer<typeof TurnLifecycleSchema>;

export const RunAttemptLifecycleSchema = z
  .object({
    runAttemptId: RunAttemptIdSchema,
    turnId: TurnIdSchema,
    status: RunAttemptStatusSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
    failure: ProtocolErrorSchema.nullable(),
  })
  .strict()
  .superRefine(validateRunAttemptLifecycleShape);
export type RunAttemptLifecycle = z.infer<typeof RunAttemptLifecycleSchema>;

export const ItemLifecycleSchema = z
  .object({
    itemId: ItemIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    kind: ItemKindSchema,
    status: ItemStatusSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
  })
  .strict()
  .superRefine(validateSettledTimestamp);
export type ItemLifecycle = z.infer<typeof ItemLifecycleSchema>;

export const ToolCallLifecycleSchema = z
  .object({
    toolCallId: ToolCallIdSchema,
    itemId: ItemIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    status: ToolCallStatusSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
  })
  .strict()
  .superRefine(validateSettledTimestamp);
export type ToolCallLifecycle = z.infer<typeof ToolCallLifecycleSchema>;

export const ApprovalLifecycleSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    itemId: ItemIdSchema,
    turnId: TurnIdSchema,
    threadId: ThreadIdSchema,
    status: ApprovalStatusSchema,
    requestedAt: ProtocolTimestampSchema,
    decidedAt: ProtocolTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((approval, context) => {
    const isSettled = isTerminalApprovalStatus(approval.status);
    if (isSettled !== (approval.decidedAt !== null)) {
      addLifecycleSchemaIssue(
        context,
        ["decidedAt"],
        "Approval decidedAt must be present exactly when approval is settled",
      );
    }
  });
export type ApprovalLifecycle = z.infer<typeof ApprovalLifecycleSchema>;

export const LifecycleTransitionSubjectSchema = z.enum([
  "turn",
  "run_attempt",
  "item",
  "tool_call",
  "approval",
  "terminal_settlement",
]);
export type LifecycleTransitionSubject = z.infer<
  typeof LifecycleTransitionSubjectSchema
>;

export class LifecycleTransitionError extends Error {
  readonly code = "illegal_lifecycle_transition" as const;

  constructor(
    readonly subject: LifecycleTransitionSubject,
    readonly from: string,
    readonly to: string,
    readonly reason: string,
  ) {
    super(`Illegal ${subject} transition from ${from} to ${to}: ${reason}`);
    this.name = "LifecycleTransitionError";
  }
}

const TURN_TRANSITIONS = {
  queued: ["in_progress", "interrupted", "failed"],
  in_progress: ["in_progress", "completed", "interrupted", "failed"],
  completed: [],
  interrupted: [],
  failed: [],
} as const satisfies Record<TurnStatus, readonly TurnStatus[]>;

const RUN_ATTEMPT_TRANSITIONS = {
  queued: ["running", "interrupted", "failed"],
  running: ["succeeded", "interrupted", "failed"],
  succeeded: [],
  interrupted: [],
  failed: [],
} as const satisfies Record<RunAttemptStatus, readonly RunAttemptStatus[]>;

const ITEM_TRANSITIONS = {
  not_started: ["active"],
  active: ["completed", "failed", "declined", "interrupted"],
  completed: [],
  failed: [],
  declined: [],
  interrupted: [],
} as const satisfies Record<ItemStatus, readonly ItemStatus[]>;

const APPROVAL_TRANSITIONS = {
  pending: ["approved", "denied", "cancelled"],
  approved: [],
  denied: [],
  cancelled: [],
} as const satisfies Record<ApprovalStatus, readonly ApprovalStatus[]>;

function transition<TState extends string>(
  subject: LifecycleTransitionSubject,
  transitions: Readonly<Record<TState, readonly TState[]>>,
  from: TState,
  to: TState,
): TState {
  if (!transitions[from].includes(to)) {
    throw new LifecycleTransitionError(
      subject,
      from,
      to,
      "the target state is not legal from the current state",
    );
  }
  return to;
}

export function transitionTurnStatus(
  from: TurnStatus,
  to: TurnStatus,
): TurnStatus {
  return transition("turn", TURN_TRANSITIONS, from, to);
}

export function transitionRunAttemptStatus(
  from: RunAttemptStatus,
  to: RunAttemptStatus,
): RunAttemptStatus {
  return transition("run_attempt", RUN_ATTEMPT_TRANSITIONS, from, to);
}

export function transitionItemStatus(
  from: ItemStatus,
  to: ItemStatus,
): ItemStatus {
  return transition("item", ITEM_TRANSITIONS, from, to);
}

export function transitionToolCallStatus(
  from: ToolCallStatus,
  to: ToolCallStatus,
): ToolCallStatus {
  return transition("tool_call", ITEM_TRANSITIONS, from, to);
}

export function transitionApprovalStatus(
  from: ApprovalStatus,
  to: ApprovalStatus,
): ApprovalStatus {
  return transition("approval", APPROVAL_TRANSITIONS, from, to);
}

export function isTerminalTurnStatus(
  status: TurnStatus,
): status is TurnTerminalStatus {
  return TurnTerminalStatusSchema.safeParse(status).success;
}

export function isTerminalItemStatus(status: ItemStatus): boolean {
  return status !== "not_started" && status !== "active";
}

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return status !== "pending";
}

export interface TerminalSettlementInput {
  readonly turnStatus: TurnStatus;
  readonly terminalOutcome: TurnTerminalOutcome | null;
  readonly blockingState: TurnBlockingState;
  readonly itemStatuses: Readonly<Record<string, ItemStatus>>;
  readonly approvalStatuses: Readonly<Record<string, ApprovalStatus>>;
}

export function validateTerminalSettlement(
  input: TerminalSettlementInput,
): void {
  if (!isTerminalTurnStatus(input.turnStatus)) {
    throw settlementError(input.turnStatus, "terminal", "turn is not terminal");
  }
  if (!input.terminalOutcome) {
    throw settlementError(
      input.turnStatus,
      "terminal",
      "terminal outcome is required",
    );
  }
  if (input.terminalOutcome.status !== input.turnStatus) {
    throw settlementError(
      input.turnStatus,
      input.terminalOutcome.status,
      "terminal outcome must match the turn status",
    );
  }
  if (input.blockingState.kind !== "none") {
    throw settlementError(
      input.turnStatus,
      "terminal",
      "blocking state must be cleared",
    );
  }
  assertAllSettled(
    input.turnStatus,
    input.itemStatuses,
    isTerminalItemStatus,
    "item",
  );
  assertAllSettled(
    input.turnStatus,
    input.approvalStatuses,
    isTerminalApprovalStatus,
    "approval",
  );
}

function assertAllSettled<TState extends string>(
  turnStatus: TurnStatus,
  states: Readonly<Record<string, TState>>,
  isSettled: (status: TState) => boolean,
  label: string,
): void {
  const unsettled = Object.entries(states).find(
    ([, status]) => !isSettled(status),
  );
  if (unsettled) {
    throw settlementError(
      turnStatus,
      "terminal",
      `${label} ${unsettled[0]} remains ${unsettled[1]}`,
    );
  }
}

function settlementError(
  from: string,
  to: string,
  reason: string,
): LifecycleTransitionError {
  return new LifecycleTransitionError("terminal_settlement", from, to, reason);
}

function validateTurnLifecycleShape(
  turn: {
    status: TurnStatus;
    blockingState: TurnBlockingState;
    completedAt: string | null;
    terminalOutcome: TurnTerminalOutcome | null;
  },
  context: z.RefinementCtx,
): void {
  const isTerminal = isTerminalTurnStatus(turn.status);
  if (isTerminal !== (turn.completedAt !== null)) {
    addLifecycleSchemaIssue(
      context,
      ["completedAt"],
      "Turn completedAt must be present exactly when the turn is terminal",
    );
  }
  if (isTerminal !== (turn.terminalOutcome !== null)) {
    addLifecycleSchemaIssue(
      context,
      ["terminalOutcome"],
      "Turn terminalOutcome must be present exactly when the turn is terminal",
    );
  }
  if (turn.terminalOutcome && turn.terminalOutcome.status !== turn.status) {
    addLifecycleSchemaIssue(
      context,
      ["terminalOutcome", "status"],
      "Turn terminalOutcome status must match turn status",
    );
  }
  if (isTerminal && turn.blockingState.kind !== "none") {
    addLifecycleSchemaIssue(
      context,
      ["blockingState"],
      "Terminal turns cannot remain blocked",
    );
  }
}

function validateRunAttemptLifecycleShape(
  attempt: {
    status: RunAttemptStatus;
    completedAt: string | null;
    failure: ProtocolError | null;
  },
  context: z.RefinementCtx,
): void {
  const isTerminal = !["queued", "running"].includes(attempt.status);
  if (isTerminal !== (attempt.completedAt !== null)) {
    addLifecycleSchemaIssue(
      context,
      ["completedAt"],
      "Run attempt completedAt must be present exactly when the attempt is terminal",
    );
  }
  if ((attempt.status === "failed") !== (attempt.failure !== null)) {
    addLifecycleSchemaIssue(
      context,
      ["failure"],
      "Run attempt failure must be present exactly when the attempt failed",
    );
  }
}

function validateSettledTimestamp(
  value: { status: ItemStatus; completedAt: string | null },
  context: z.RefinementCtx,
): void {
  if (isTerminalItemStatus(value.status) !== (value.completedAt !== null)) {
    addLifecycleSchemaIssue(
      context,
      ["completedAt"],
      "completedAt must be present exactly when the lifecycle is settled",
    );
  }
}

function addLifecycleSchemaIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

export const LifecycleEventTypeSchema = z.enum([
  "thread.created",
  "thread.updated",
  "thread.archived",
  "turn.queued",
  "turn.started",
  "turn.blocking_changed",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "run_attempt.started",
  "run_attempt.succeeded",
  "run_attempt.interrupted",
  "run_attempt.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "item.failed",
  "item.declined",
  "item.interrupted",
  "assistant_message.delta",
  "reasoning.summary_delta",
  "plan.updated",
  "tool_call.input_delta",
  "tool_call.output_delta",
  "command_execution.output_delta",
  "file_change.patch_updated",
  "turn.diff_updated",
  "approval.requested",
  "approval.decided",
  "user_input.requested",
  "user_input.responded",
  "request.resolved",
  "workspace.snapshot_captured",
  "workspace.state_changed",
  "artifact.created",
  "artifact.finalized",
]);
export type LifecycleEventType = z.infer<typeof LifecycleEventTypeSchema>;

export const LifecycleEventProducerSchema = z
  .object({
    kind: z.literal("runtime_kernel"),
    id: z.string().min(1).max(160),
  })
  .strict();
export type LifecycleEventProducer = z.infer<
  typeof LifecycleEventProducerSchema
>;

const LifecycleEventEnvelopeShape = {
  eventId: EventIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  sequence: EventSequenceSchema,
  idempotencyKey: z.string().min(1).max(200),
  producer: LifecycleEventProducerSchema,
  schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
  createdAt: ProtocolTimestampSchema,
} as const;

const ItemLifecycleEventTypeSchema = z.enum([
  "item.started",
  "item.updated",
  "assistant_message.delta",
  "reasoning.summary_delta",
  "plan.updated",
  "command_execution.output_delta",
  "file_change.patch_updated",
]);

const ItemLifecycleEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    type: ItemLifecycleEventTypeSchema,
    payload: JsonRecordSchema,
  })
  .strict();

const ItemCompletedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    type: z.literal("item.completed"),
    payload: z.object({ result: JsonRecordSchema }).strict(),
  })
  .strict();

const ItemFailedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    type: z.literal("item.failed"),
    payload: z.object({ failure: ProtocolErrorSchema }).strict(),
  })
  .strict();

const ItemDeclinedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    type: z.literal("item.declined"),
    payload: z.object({ reason: z.string().min(1).max(2_000) }).strict(),
  })
  .strict();

const ItemInterruptedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    type: z.literal("item.interrupted"),
    payload: z.object({ reason: z.string().min(1).max(2_000) }).strict(),
  })
  .strict();

const ToolCallLifecycleEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    toolCallId: ToolCallIdSchema,
    type: z.enum(["tool_call.input_delta", "tool_call.output_delta"]),
    payload: JsonRecordSchema,
  })
  .strict();

const ApprovalLifecycleEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    approvalId: ApprovalIdSchema,
    type: z.enum(["approval.requested", "approval.decided"]),
    payload: JsonRecordSchema,
  })
  .strict();

const RequestIdSchema = z.string().min(1).max(160);
const RequestLifecycleEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema,
    requestId: RequestIdSchema,
    type: z.enum([
      "user_input.requested",
      "user_input.responded",
      "request.resolved",
    ]),
    payload: JsonRecordSchema,
  })
  .strict();

const TurnCompletedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    type: z.literal("turn.completed"),
    payload: z
      .object({
        outcome: z.object({ status: z.literal("completed") }).strict(),
      })
      .strict(),
  })
  .strict();

const TurnInterruptedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    type: z.literal("turn.interrupted"),
    payload: z
      .object({
        outcome: InterruptedTurnOutcomeSchema,
      })
      .strict(),
  })
  .strict();

const TurnFailedEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    type: z.literal("turn.failed"),
    payload: z
      .object({
        outcome: FailedTurnOutcomeSchema,
      })
      .strict(),
  })
  .strict();

const TurnLifecycleEventSchema = z
  .object({
    ...LifecycleEventEnvelopeShape,
    itemId: ItemIdSchema.optional(),
    type: LifecycleEventTypeSchema.exclude([
      ...ItemLifecycleEventTypeSchema.options,
      "tool_call.input_delta",
      "tool_call.output_delta",
      "approval.requested",
      "approval.decided",
      "user_input.requested",
      "user_input.responded",
      "request.resolved",
      "item.completed",
      "item.failed",
      "item.declined",
      "item.interrupted",
      "turn.completed",
      "turn.interrupted",
      "turn.failed",
    ]),
    payload: JsonRecordSchema,
  })
  .strict();

export const LifecycleEventSchema = z.union([
  ItemLifecycleEventSchema,
  ItemCompletedEventSchema,
  ItemFailedEventSchema,
  ItemDeclinedEventSchema,
  ItemInterruptedEventSchema,
  ToolCallLifecycleEventSchema,
  ApprovalLifecycleEventSchema,
  RequestLifecycleEventSchema,
  TurnCompletedEventSchema,
  TurnInterruptedEventSchema,
  TurnFailedEventSchema,
  TurnLifecycleEventSchema,
]);
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export interface TurnLifecycleState {
  readonly turnId: TurnId;
  readonly status: TurnStatus;
  readonly blockingState: TurnBlockingState;
  readonly terminalOutcome: TurnTerminalOutcome | null;
  readonly runAttempts: Readonly<Record<RunAttemptId, RunAttemptStatus>>;
  readonly items: Readonly<Record<ItemId, ItemStatus>>;
  readonly toolCalls: Readonly<Record<ToolCallId, ToolCallStatus>>;
  readonly approvals: Readonly<Record<ApprovalId, ApprovalStatus>>;
  readonly lastSequence: number;
}

export function assertNextLifecycleSequence(
  state: Pick<TurnLifecycleState, "lastSequence">,
  nextSequence: number,
): void {
  if (nextSequence !== state.lastSequence + 1) {
    throw new LifecycleTransitionError(
      "turn",
      String(state.lastSequence),
      String(nextSequence),
      "lifecycle event sequence must be contiguous and monotonic",
    );
  }
}

export function assertTurnAcceptsLifecycleEvent(
  status: TurnStatus,
  eventType: LifecycleEventType,
): void {
  if (isTerminalTurnStatus(status)) {
    throw new LifecycleTransitionError(
      "turn",
      status,
      eventType,
      "terminal turns cannot accept lifecycle events",
    );
  }
}

export interface ApprovalDecisionInput {
  readonly approvalId: ApprovalId;
  readonly status: ApprovalStatus;
}

export interface ToolCallTransitionInput {
  readonly toolCallId: ToolCallId;
  readonly status: ToolCallStatus;
}

export interface LifecycleFailure {
  readonly failure: ProtocolError;
}
