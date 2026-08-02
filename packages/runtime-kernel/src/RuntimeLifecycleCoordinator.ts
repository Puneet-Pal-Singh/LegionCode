import {
  EventIdSchema,
  JsonRecordSchema,
  type ApprovalId,
  type ItemId,
  type JsonRecord,
  type ProtocolError,
  type RunAttemptId,
  type ThreadId,
  type ToolCallId,
  type TurnId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import {
  LifecycleEventSchema,
  LifecycleTransitionError,
  LIFECYCLE_SCHEMA_VERSION,
  assertTurnAcceptsLifecycleEvent,
  transitionApprovalStatus,
  transitionItemStatus,
  transitionRunAttemptStatus,
  transitionToolCallStatus,
  transitionTurnStatus,
  validateTerminalSettlement,
  type ApprovalStatus,
  type ItemKind,
  type LifecycleToolDisplay,
  type ContextBudgetSnapshot,
  type UsageCostSnapshot,
  type ContextCompactionPayload,
  type ItemStatus,
  type LifecycleEvent,
  type LifecycleEventType,
  type RunAttemptStatus,
  type ToolCallStatus,
  type TurnBlockingState,
  type TurnStatus,
  type TurnTerminalOutcome,
} from "@repo/platform-protocol/lifecycle";
import { RuntimeLifecycleSettlementError } from "./errors.js";
import type {
  RuntimeLifecycleEventStore,
  RuntimeKernelClock,
} from "./ports.js";

interface LifecycleIdentity {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
}

export interface RuntimeLifecycleCoordinatorOptions extends LifecycleIdentity {
  readonly sink: Pick<RuntimeLifecycleEventStore, "appendBatch">;
  readonly producerId: string;
  readonly clock: RuntimeKernelClock;
  readonly initialSequence?: number;
}

interface EventFields {
  readonly type: LifecycleEventType;
  readonly itemId?: ItemId;
  readonly toolCallId?: ToolCallId;
  readonly approvalId?: ApprovalId;
  readonly payload: JsonRecord;
}

type RuntimeHookAuditEventType = Extract<
  LifecycleEventType,
  | "hook.invocation.started"
  | "hook.invocation.completed"
  | "hook.invocation.failed"
  | "hook.invocation.timed_out"
  | "hook.invocation.cancelled"
>;

const RUNTIME_HOOK_AUDIT_EVENT_TYPES = new Set<LifecycleEventType>([
  "hook.invocation.started",
  "hook.invocation.completed",
  "hook.invocation.failed",
  "hook.invocation.timed_out",
  "hook.invocation.cancelled",
]);

const MAX_LIFECYCLE_OUTPUT_LENGTH = 4_000;

export class RuntimeLifecycleCoordinator {
  private status: TurnStatus = "queued";
  private blockingState: TurnBlockingState = { kind: "none" };
  private runAttemptStatus: RunAttemptStatus = "queued";
  private readonly itemStatuses: Record<string, ItemStatus> = {};
  private readonly toolCallStatuses: Record<string, ToolCallStatus> = {};
  private readonly toolCallItems: Record<string, ItemId> = {};
  private readonly approvalStatuses: Record<string, ApprovalStatus> = {};
  private readonly approvalItems: Record<string, ItemId> = {};
  private accepted = false;
  private sequence: number;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeLifecycleCoordinatorOptions) {
    this.sequence = options.initialSequence ?? 0;
  }

  get isTerminal(): boolean {
    return ["completed", "interrupted", "failed"].includes(this.status);
  }

  async start(): Promise<{
    readonly turnStarted: LifecycleEvent;
    readonly runAttemptStarted: LifecycleEvent;
  }> {
    let result:
      | {
          readonly turnStarted: LifecycleEvent;
          readonly runAttemptStarted: LifecycleEvent;
        }
      | undefined;
    await this.enqueue(async () => {
      result = await this.startNow();
    });
    if (!result) {
      throw new Error("Runtime lifecycle start did not append its events.");
    }
    return result;
  }

  private async startNow(): Promise<{
    readonly turnStarted: LifecycleEvent;
    readonly runAttemptStarted: LifecycleEvent;
  }> {
    if (this.accepted) {
      throw new LifecycleTransitionError(
        "turn",
        this.status,
        "turn.started",
        "runtime lifecycle already started",
      );
    }
    const nextTurn = transitionTurnStatus(this.status, "in_progress");
    const nextAttempt = transitionRunAttemptStatus(
      this.runAttemptStatus,
      "running",
    );
    const events = [
      this.createEvent({ type: "turn.queued", payload: {} }, 1),
      this.createEvent({ type: "turn.started", payload: {} }, 2),
      this.createEvent({ type: "run_attempt.started", payload: {} }, 3),
    ];
    await this.options.sink.appendBatch(events);
    this.sequence += events.length;
    this.accepted = true;
    this.status = nextTurn;
    this.runAttemptStatus = nextAttempt;
    return {
      turnStarted: events[1] as LifecycleEvent,
      runAttemptStarted: events[2] as LifecycleEvent,
    };
  }

  async startToolCall(
    itemId: ItemId,
    toolCallId: ToolCallId,
    input: JsonRecord,
    display?: LifecycleToolDisplay,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.startToolCallNow(itemId, toolCallId, input, display),
    );
  }

  async appendAssistantCommentary(itemId: ItemId, text: string): Promise<void> {
    const bounded = text.slice(0, MAX_LIFECYCLE_OUTPUT_LENGTH);
    if (!bounded.trim()) return;
    await this.enqueue(async () => {
      await this.startItem(itemId, "commentary", {});
      await this.emit({
        type: "assistant_message.delta",
        itemId,
        payload: { phase: "commentary", delta: bounded },
      });
      await this.settleItem(itemId, "completed", { result: { text: bounded } });
    });
  }

  private async startToolCallNow(
    itemId: ItemId,
    toolCallId: ToolCallId,
    input: JsonRecord,
    display?: LifecycleToolDisplay,
  ): Promise<void> {
    await this.startItem(itemId, "tool_call", display ? { display } : {});
    const next = transitionToolCallStatus("not_started", "active");
    await this.emit({
      type: "tool_call.started",
      itemId,
      toolCallId,
      payload: display ? { display } : {},
    });
    this.toolCallStatuses[toolCallId] = next;
    this.toolCallItems[toolCallId] = itemId;
    await this.emit({
      type: "tool_call.input_delta",
      itemId,
      toolCallId,
      payload: { input },
    });
  }

  async appendToolOutput(
    toolCallId: ToolCallId,
    output: string,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.appendToolOutputNow(toolCallId, output),
    );
  }

  private async appendToolOutputNow(
    toolCallId: ToolCallId,
    output: string,
  ): Promise<void> {
    this.requireActiveToolCall(toolCallId);
    await this.emit({
      type: "tool_call.output_delta",
      itemId: this.requireToolCallItem(toolCallId),
      toolCallId,
      payload: { output: output.slice(0, MAX_LIFECYCLE_OUTPUT_LENGTH) },
    });
  }

  async createArtifact(itemId: ItemId, artifact: unknown): Promise<void> {
    await this.enqueue(async () => this.createArtifactNow(itemId, artifact));
  }

  async captureWorkspaceSnapshot(snapshot: unknown): Promise<void> {
    await this.enqueue(async () =>
      this.emit({
        type: "workspace.snapshot_captured",
        payload: { snapshot: JsonRecordSchema.parse(snapshot) },
      }),
    );
  }

  /**
   * Appends a sanitized hook invocation through the same serialized sequence
   * owner as every other runtime event. Hook execution and outcome application
   * remain outside this coordinator.
   */
  async appendHookAudit(
    eventType: RuntimeHookAuditEventType,
    payload: JsonRecord,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (!RUNTIME_HOOK_AUDIT_EVENT_TYPES.has(eventType)) {
        throw new Error("Unsupported runtime hook audit event type.");
      }
      await this.emit({
        type: eventType,
        payload: JsonRecordSchema.parse(payload),
      });
    });
  }

  async createTurnArtifact(artifact: unknown): Promise<void> {
    await this.enqueue(async () =>
      this.emit({
        type: "artifact.created",
        payload: { artifact: JsonRecordSchema.parse(artifact) },
      }),
    );
  }

  async updateTurnDiff(diff: unknown): Promise<void> {
    await this.enqueue(async () =>
      this.emit({
        type: "turn.diff_updated",
        payload: { diff: JsonRecordSchema.parse(diff) },
      }),
    );
  }

  async updateContextBudget(snapshot: ContextBudgetSnapshot): Promise<void> {
    await this.enqueue(async () =>
      this.emit({
        type: "context_budget.updated",
        payload: { snapshot },
      }),
    );
  }

  async updateUsage(usage: UsageCostSnapshot): Promise<void> {
    await this.enqueue(async () =>
      this.emit({
        type: "usage.updated",
        payload: { usage },
      }),
    );
  }

  async requestContextCompaction(
    payload: ContextCompactionPayload,
  ): Promise<void> {
    await this.enqueue(async () => {
      await this.startItem(payload.itemId, "context_compaction", {
        kind: "context_compaction",
        mode: payload.mode,
      });
      await this.emit({
        type: "context_compaction.requested",
        itemId: payload.itemId,
        payload: { ...payload, phase: "requested" },
      });
      await this.emit({
        type: "context_compaction.started",
        itemId: payload.itemId,
        payload: { ...payload, phase: "compacting" },
      });
    });
  }

  async settleContextCompaction(
    payload: ContextCompactionPayload,
  ): Promise<void> {
    await this.enqueue(async () => {
      const terminal = payload.phase === "failed" ? "failed" : "completed";
      await this.emit({
        type: `context_compaction.${terminal}`,
        itemId: payload.itemId,
        payload,
      });
      await this.settleItem(
        payload.itemId,
        terminal,
        terminal === "failed"
          ? { reason: payload.error ?? "Context compaction failed" }
          : { result: { preservedContextReference: payload.preservedContextReference } },
      );
    });
  }

  private async createArtifactNow(
    itemId: ItemId,
    artifact: unknown,
  ): Promise<void> {
    await this.emit({
      type: "artifact.created",
      itemId,
      payload: { artifact: JsonRecordSchema.parse(artifact) },
    });
  }

  async completeToolCall(
    toolCallId: ToolCallId,
    result: JsonRecord,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.settleToolCall(toolCallId, "completed", { result }),
    );
  }

  async failToolCall(
    toolCallId: ToolCallId,
    failure: ProtocolError,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.settleToolCall(toolCallId, "failed", { failure }),
    );
  }

  async declineToolCall(toolCallId: ToolCallId, reason: string): Promise<void> {
    await this.enqueue(async () =>
      this.settleToolCall(toolCallId, "declined", { reason }),
    );
  }

  async requestApproval(
    parentItemId: ItemId,
    approvalId: ApprovalId,
    approvalItemId: ItemId,
    payload: JsonRecord,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.requestApprovalNow(
        parentItemId,
        approvalId,
        approvalItemId,
        payload,
      ),
    );
  }

  private async requestApprovalNow(
    parentItemId: ItemId,
    approvalId: ApprovalId,
    approvalItemId: ItemId,
    payload: JsonRecord,
  ): Promise<void> {
    await this.startItem(approvalItemId, "approval_request", { parentItemId });
    await this.emit({
      type: "approval.requested",
      itemId: approvalItemId,
      approvalId,
      payload,
    });
    this.approvalStatuses[approvalId] = "pending";
    this.approvalItems[approvalId] = approvalItemId;
    await this.changeBlocking({
      kind: "waiting_for_approval",
      itemId: approvalItemId,
      approvalId,
    });
  }

  async decideApproval(
    approvalId: ApprovalId,
    status: Exclude<ApprovalStatus, "pending">,
    payload: JsonRecord,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.decideApprovalNow(approvalId, status, payload),
    );
  }

  private async decideApprovalNow(
    approvalId: ApprovalId,
    status: Exclude<ApprovalStatus, "pending">,
    payload: JsonRecord,
  ): Promise<void> {
    const current = this.approvalStatuses[approvalId] ?? "pending";
    const next = transitionApprovalStatus(current, status);
    await this.emit({
      type: "approval.decided",
      itemId: this.requireApprovalItem(approvalId),
      approvalId,
      payload: { ...payload, status },
    });
    this.approvalStatuses[approvalId] = next;
    await this.changeBlocking({ kind: "none" });
    const itemId = this.requireApprovalItem(approvalId);
    await this.settleItem(
      itemId,
      status === "approved" ? "completed" : "declined",
      status === "approved" ? { result: {} } : { reason: `Approval ${status}` },
    );
  }

  async complete(output: string, itemId: ItemId): Promise<void> {
    await this.enqueue(async () => this.completeNow(output, itemId));
  }

  private async completeNow(output: string, itemId: ItemId): Promise<void> {
    await this.startItem(itemId, "assistant_message", {});
    await this.emit({
      type: "assistant_message.delta",
      itemId,
      payload: { phase: "final_answer", delta: output },
    });
    await this.settleItem(itemId, "completed", { result: { output } });
    await this.settleTurn({ status: "completed" });
  }

  async fail(failure: ProtocolError): Promise<void> {
    await this.enqueue(async () => this.failNow(failure));
  }

  private async failNow(failure: ProtocolError): Promise<void> {
    await this.cancelPendingApprovals("Turn failed before approval resolution");
    await this.settleOpenWork("failed", { failure });
    await this.settleTurn({ status: "failed", failure });
  }

  async interrupt(reason: string): Promise<void> {
    await this.enqueue(async () => this.interruptNow(reason));
  }

  private async interruptNow(reason: string): Promise<void> {
    await this.cancelPendingApprovals(reason);
    await this.settleOpenWork("interrupted", { reason });
    await this.settleTurn({ status: "interrupted", reason });
  }

  private async startItem(
    itemId: ItemId,
    kind: ItemKind,
    payload: JsonRecord,
  ): Promise<void> {
    const next = transitionItemStatus("not_started", "active");
    await this.emit({
      type: "item.started",
      itemId,
      payload: { ...payload, kind },
    });
    this.itemStatuses[itemId] = next;
  }

  private async settleToolCall(
    toolCallId: ToolCallId,
    status: Exclude<ToolCallStatus, "not_started" | "active">,
    payload: JsonRecord,
  ): Promise<void> {
    const current = this.requireActiveToolCall(toolCallId);
    const next = transitionToolCallStatus(current, status);
    const itemId = this.requireToolCallItem(toolCallId);
    await this.emit({
      type: `tool_call.${status}`,
      itemId,
      toolCallId,
      payload,
    });
    this.toolCallStatuses[toolCallId] = next;
    await this.settleItem(itemId, status, payload);
  }

  private async settleItem(
    itemId: ItemId,
    status: Exclude<ItemStatus, "not_started" | "active">,
    payload: JsonRecord,
  ): Promise<void> {
    const current = this.itemStatuses[itemId] ?? "not_started";
    const next = transitionItemStatus(current, status);
    await this.emit({ type: `item.${status}`, itemId, payload });
    this.itemStatuses[itemId] = next;
  }

  private async settleOpenWork(
    status: "failed" | "interrupted",
    payload: JsonRecord,
  ): Promise<void> {
    for (const [toolCallId, current] of Object.entries(this.toolCallStatuses)) {
      if (current === "active") {
        await this.settleToolCall(toolCallId as ToolCallId, status, payload);
      }
    }
    for (const [itemId, current] of Object.entries(this.itemStatuses)) {
      if (current === "active") {
        await this.settleItem(itemId as ItemId, status, payload);
      }
    }
  }

  private async cancelPendingApprovals(reason: string): Promise<void> {
    for (const [approvalId, status] of Object.entries(this.approvalStatuses)) {
      if (status === "pending") {
        await this.decideApprovalNow(approvalId as ApprovalId, "cancelled", {
          reason,
        });
      }
    }
  }

  private async settleTurn(outcome: TurnTerminalOutcome): Promise<void> {
    if (this.isTerminal) {
      return;
    }
    const nextTurn = transitionTurnStatus(this.status, outcome.status);
    const attemptStatus =
      outcome.status === "completed" ? "succeeded" : outcome.status;
    const nextAttempt = transitionRunAttemptStatus(
      this.runAttemptStatus,
      attemptStatus,
    );
    validateTerminalSettlement({
      turnStatus: nextTurn,
      terminalOutcome: outcome,
      blockingState: this.blockingState,
      itemStatuses: this.itemStatuses,
      approvalStatuses: this.approvalStatuses,
    });
    const attemptPayload: JsonRecord =
      outcome.status === "failed" ? { failure: outcome.failure } : {};
    const events = [
      this.createEvent(
        { type: `run_attempt.${attemptStatus}`, payload: attemptPayload },
        1,
      ),
      this.createEvent(
        { type: `turn.${outcome.status}`, payload: { outcome } },
        2,
      ),
    ];
    await this.appendTerminalBatch(events, outcome.status);
    this.sequence += events.length;
    this.runAttemptStatus = nextAttempt;
    this.status = nextTurn;
  }

  private async changeBlocking(
    blockingState: TurnBlockingState,
  ): Promise<void> {
    await this.emit({
      type: "turn.blocking_changed",
      payload: { blockingState },
    });
    if (blockingState.kind === "waiting_for_approval") {
      this.status = transitionTurnStatus(this.status, "awaiting_approval");
    } else if (this.status === "awaiting_approval") {
      this.status = transitionTurnStatus(this.status, "in_progress");
    }
    this.blockingState = blockingState;
  }

  private async appendTerminalBatch(
    events: readonly LifecycleEvent[],
    intendedStatus: TurnTerminalOutcome["status"],
  ): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.options.sink.appendBatch(events);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw new RuntimeLifecycleSettlementError(intendedStatus, failure);
  }

  private requireActiveToolCall(toolCallId: ToolCallId): "active" {
    const status = this.toolCallStatuses[toolCallId] ?? "not_started";
    if (status !== "active") {
      transitionToolCallStatus(status, "completed");
    }
    return "active";
  }

  private requireToolCallItem(toolCallId: ToolCallId): ItemId {
    const itemId = this.toolCallItems[toolCallId];
    if (!itemId) {
      throw new LifecycleTransitionError(
        "tool_call",
        "missing",
        "active",
        `tool call ${toolCallId} has no owning item`,
      );
    }
    return itemId;
  }

  private requireApprovalItem(approvalId: ApprovalId): ItemId {
    const itemId = this.approvalItems[approvalId];
    if (!itemId) {
      throw new LifecycleTransitionError(
        "approval",
        "missing",
        "decided",
        `approval ${approvalId} has no owning item`,
      );
    }
    return itemId;
  }

  private async emit(fields: EventFields): Promise<void> {
    assertTurnAcceptsLifecycleEvent(this.status, fields.type);
    const event = this.createEvent(fields, 1);
    await this.options.sink.appendBatch([event]);
    this.sequence = event.sequence;
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => undefined);
    await result;
  }

  private createEvent(fields: EventFields, offset: number): LifecycleEvent {
    const sequence = this.sequence + offset;
    return LifecycleEventSchema.parse({
      eventId: EventIdSchema.parse(
        `evt_${this.options.turnId.slice(4)}_${sequence}`,
      ),
      threadId: this.options.threadId,
      turnId: this.options.turnId,
      runAttemptId: this.options.runAttemptId,
      sequence,
      idempotencyKey: `${this.options.turnId}:${sequence}:${fields.type}`,
      producer: { kind: "runtime_kernel", id: this.options.producerId },
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      createdAt: this.options.clock.now(),
      ...fields,
    });
  }
}
