import { HarnessCommitAckSchema, type HarnessCommitAck, type HarnessObservation } from "@repo/worker-protocol";
import type { HarnessObservationCommitPort } from "./harness/DelegatedHarnessPort.js";
import {
  EventIdSchema,
  toPublicProtocolError,
  type HarnessActivityMeasuredPayload,
  type HarnessProviderLimitNotifiedPayload,
  JsonRecordSchema,
  type ApprovalId,
  type ItemId,
  type JsonRecord,
  type ProtocolError,
  type ResumeWorkspaceUnavailableReason,
  type RunAttemptId,
  type ThreadId,
  type ToolCallId,
  type TurnId,
  type WorkspaceId,
  type ToolCallBatchId,
} from "@repo/platform-protocol";
import {
  LifecycleEventSchema,
  LifecycleTransitionError,
  LIFECYCLE_SCHEMA_VERSION,
  ItemKindSchema,
  assertTurnAcceptsLifecycleEvent,
  assertNextLifecycleSequence,
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
  TurnBlockingStateSchema,
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
  /** The latest terminal turn superseded by this edited/recovery turn. */
  readonly revisionOfTurnId?: TurnId;
  readonly continuationOfTurnId?: TurnId;
  readonly originalPromptId?: string;
  readonly executionCapability?: "repository" | "conversation";
}

interface EventFields {
  readonly type: LifecycleEventType;
  readonly itemId?: ItemId;
  readonly toolCallId?: ToolCallId;
  readonly approvalId?: ApprovalId;
  readonly requestId?: string;
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
  private readonly itemKinds: Record<string, ItemKind> = {};
  private readonly toolCallStatuses: Record<string, ToolCallStatus> = {};
  private readonly toolCallNames: Record<string, string> = {};
  private readonly toolCallBatches: Record<string, ToolCallBatchId> = {};
  private readonly toolCallItems: Record<string, ItemId> = {};
  private readonly approvalStatuses: Record<string, ApprovalStatus> = {};
  private readonly approvalItems: Record<string, ItemId> = {};
  private readonly userInputItems: Record<string, ItemId> = {};
  private readonly userInputStatuses: Record<string, "pending" | "responded" | "cancelled"> = {};
  private readonly approvalParents: Record<string, ItemId> = {};
  private accepted = false;
  private completionReserved = false;
  private harnessFenced = false;
  private terminalOutcome: TurnTerminalOutcome["status"] | null = null;
  private readonly acceptedInputSequences = new Map<string, number>();
  private readonly appliedInputs = new Map<string, { acceptedSequence: number; modelStep: number; contextRevision: number; sequence: number }>();
  private sequence: number;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeLifecycleCoordinatorOptions) {
    this.sequence = options.initialSequence ?? 0;
  }

  /** Serialize draft generation with ordinary lifecycle work. Only committed
   * state is adopted; an append failure leaves the live coordinator unchanged. */
  async commitHarnessObservation(
    observation: HarnessObservation,
    persistence: HarnessObservationCommitPort,
    apply: (draft: RuntimeLifecycleCoordinator) => Promise<void>,
  ): Promise<HarnessCommitAck> {
    let acknowledgement: HarnessCommitAck | undefined;
    await this.enqueue(async () => {
      const existing = await persistence.lookup(observation);
      if (existing) { acknowledgement = this.validateHarnessAck(existing, observation); return; }
      const events: LifecycleEvent[] = [];
      const draft = new RuntimeLifecycleCoordinator({
        ...this.options,
        sink: { appendBatch: async (batch) => { events.push(...batch); return batch; } },
      });
      draft.copyStateFrom(this);
      await apply(draft);
      try {
        acknowledgement = this.validateHarnessAck(await persistence.commit({ observation, events }), observation);
      } catch (error) {
        // The durable transaction may have committed before transport failed.
        // No further append may use this coordinator's now-uncertain sequence.
        this.harnessFenced = true;
        throw error;
      }
      this.copyStateFrom(draft);
    });
    if (!acknowledgement) throw new Error("Observation commit returned no acknowledgement");
    return acknowledgement;
  }

  private validateHarnessAck(input: HarnessCommitAck, observation: HarnessObservation): HarnessCommitAck {
    const ack = HarnessCommitAckSchema.parse(input);
    const a = ack.session, b = observation.session;
    if (ack.committedSequence !== observation.sequence || a.runAttemptId !== b.runAttemptId ||
      a.instanceId !== b.instanceId || a.externalSessionId !== b.externalSessionId || a.processGeneration !== b.processGeneration) {
      throw new Error("Canonical observation commit returned a mismatched acknowledgement");
    }
    return ack;
  }

  private copyStateFrom(source: RuntimeLifecycleCoordinator): void {
    this.status = source.status;
    this.blockingState = source.blockingState;
    this.runAttemptStatus = source.runAttemptStatus;
    this.accepted = source.accepted;
    this.completionReserved = source.completionReserved;
    this.terminalOutcome = source.terminalOutcome;
    this.harnessFenced = source.harnessFenced;
    this.sequence = source.sequence;
    for (const key of ["itemStatuses", "itemKinds", "toolCallStatuses", "toolCallNames",
      "toolCallBatches", "toolCallItems", "approvalStatuses", "approvalItems", "approvalParents", "userInputItems", "userInputStatuses"] as const) {
      for (const existing of Object.keys(this[key])) delete this[key][existing];
      Object.assign(this[key], source[key]);
    }
    this.appliedInputs.clear();
    for (const [key, value] of source.appliedInputs) this.appliedInputs.set(key, { ...value });
    this.acceptedInputSequences.clear();
    for (const [key, value] of source.acceptedInputSequences) this.acceptedInputSequences.set(key, value);
  }

  get requiresHarnessRecovery(): boolean { return this.harnessFenced; }

  async restoreHarnessHistory(history: readonly LifecycleEvent[]): Promise<void> {
    const events = history.map((event) => LifecycleEventSchema.parse(event));
    // Recovery is the one explicit operation allowed to replace fenced state.
    const recovery = this.operationQueue.then(async () => {
      const restored = new RuntimeLifecycleCoordinator({ ...this.options, initialSequence: 0 });
      restored.restoreApprovalWaitState(events, false);
      this.copyStateFrom(restored);
    });
    this.operationQueue = recovery.catch(() => undefined);
    await recovery;
  }

  /** Canonical failure settlement for an integrity-lost host stream. This does
   * not prove physical quiescence or release a lease, and never repairs a gap. */
  async resolveObservationIntegrity(input: {
    readonly command: import("@repo/worker-protocol").HarnessStartCommand;
    readonly session: import("@repo/worker-protocol").HarnessSession;
    readonly signal: AbortSignal;
    readonly persistence: HarnessObservationCommitPort;
  }): Promise<import("./harness/DelegatedHarnessPort.js").HarnessObservationRecovery> {
    input.signal.throwIfAborted();
    const selection = input.command.selection;
    if (selection.turnId !== this.options.turnId || selection.threadId !== this.options.threadId ||
      selection.runAttemptId !== this.options.runAttemptId || selection.workspaceId !== this.options.workspaceId ||
      input.session.runAttemptId !== selection.runAttemptId || input.session.instanceId !== selection.instanceId) throw new Error("Integrity resolution does not match canonical runtime ownership");
    const recovered = await input.persistence.recover(input.session);
    if (recovered.session.runAttemptId !== input.session.runAttemptId || recovered.session.instanceId !== input.session.instanceId ||
      recovered.session.externalSessionId !== input.session.externalSessionId || recovered.session.processGeneration !== input.session.processGeneration) throw new Error("Integrity recovery replay has a stale process/session");
    input.signal.throwIfAborted();
    await this.restoreHarnessHistory(recovered.lifecycleEvents);
    const terminal = recovered.lifecycleEvents.find((event) => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type));
    if (terminal?.type === "turn.completed") throw new Error("Integrity loss conflicts with committed success; stream must remain fenced");
    if (!terminal) {
      await this.markWorkspaceSnapshotUnavailable("observation_integrity_lost");
      input.signal.throwIfAborted();
      await this.fail({ code: "command_failed", message: "Harness observation integrity was lost; execution requires recovery.",
        retryable: false, correlationId: null, details: { reason: "observation_integrity_lost" } });
    }
    const settled = await input.persistence.recover(input.session);
    input.signal.throwIfAborted();
    if (!settled.lifecycleEvents.some((event) => event.turnId === selection.turnId && event.runAttemptId === selection.runAttemptId &&
      (event.type === "turn.failed" || event.type === "turn.interrupted"))) throw new Error("Canonical failure settlement was not confirmed by replay");
    return settled;
  }

  static restoreForInterruption(
    options: RuntimeLifecycleCoordinatorOptions,
    history: readonly unknown[],
  ): RuntimeLifecycleCoordinator {
    if (history.length === 0) {
      throw new LifecycleTransitionError(
        "turn",
        "missing",
        "awaiting_approval",
        "recovery requires a canonical approval-wait history",
      );
    }
    const events = history.map((event) => LifecycleEventSchema.parse(event));
    const coordinator = new RuntimeLifecycleCoordinator({
      ...options,
      initialSequence: 0,
    });
    coordinator.restoreApprovalWaitState(events);
    return coordinator;
  }

  private restoreApprovalWaitState(events: readonly LifecycleEvent[], requireIsolatedApproval = true): void {
    let previousStatus: TurnStatus = "queued";
    let queued = false;
    let started = false;
    let lastEvent: LifecycleEvent | undefined;

    for (const event of events) {
      assertNextLifecycleSequence(
        { lastSequence: this.sequence },
        event.sequence,
      );
      if (
        event.threadId !== this.options.threadId ||
        event.turnId !== this.options.turnId ||
        event.runAttemptId !== this.options.runAttemptId
      ) {
        throw new LifecycleTransitionError(
          "turn",
          this.options.turnId,
          event.turnId,
          "lifecycle identity changed during approval-wait restoration",
        );
      }
      assertTurnAcceptsLifecycleEvent(previousStatus, event.type);
      if (
        event.type !== "turn.queued" &&
        event.type !== "turn.started" &&
        event.type !== "run_attempt.started" &&
        (!started || this.runAttemptStatus !== "running") &&
        (requireIsolatedApproval || !["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))
      ) {
        throw new LifecycleTransitionError(
          "turn",
          previousStatus,
          event.type,
          "lifecycle work requires a running run attempt",
        );
      }

      if (event.type === "turn.queued") {
        if (queued || started || event.sequence !== 1) {
          throw new LifecycleTransitionError(
            "turn",
            String(event.sequence),
            "turn.queued",
            "turn acceptance must begin the canonical lifecycle",
          );
        }
        queued = true;
      } else if (event.type === "turn.started") {
        if (!queued || started) {
          throw new LifecycleTransitionError(
            "turn",
            previousStatus,
            "turn.started",
            "turn must be accepted exactly once before it starts",
          );
        }
        const eventRevision = event.payload.revisionOfTurnId;
        if (
          (eventRevision !== undefined && typeof eventRevision !== "string") ||
          eventRevision !== this.options.revisionOfTurnId
        ) {
          throw new LifecycleTransitionError(
            "turn",
            typeof eventRevision === "string"
              ? eventRevision
              : "missing_revision",
            this.options.revisionOfTurnId ?? "no_revision",
            "turn revision identity changed during lifecycle restoration",
          );
        }
        if (
          event.payload.continuationOfTurnId !== this.options.continuationOfTurnId ||
          event.payload.originalPromptId !== this.options.originalPromptId
        ) {
          throw new LifecycleTransitionError(
            "turn",
            event.payload.continuationOfTurnId ?? "no_continuation",
            this.options.continuationOfTurnId ?? "no_continuation",
            "turn continuation identity changed during lifecycle restoration",
          );
        }
        previousStatus = transitionTurnStatus(previousStatus, "in_progress");
        started = true;
        this.accepted = true;
      } else if (event.type === "turn.blocking_changed") {
        if (!started) {
          throw new LifecycleTransitionError(
            "turn",
            previousStatus,
            "turn.blocking_changed",
            "turn must be started before it can block",
          );
        }
        const blocking = TurnBlockingStateSchema.parse(
          event.payload.blockingState,
        );
        if (
          blocking.kind !== "none" &&
          blocking.kind !== "waiting_for_approval" &&
          (requireIsolatedApproval || blocking.kind !== "waiting_for_user_input")
        ) {
          throw new LifecycleTransitionError(
            "turn",
            blocking.kind,
            "waiting_for_approval",
            "only approval-wait recovery is supported",
          );
        }
        if (blocking.kind === "waiting_for_approval") {
          if (
            this.approvalStatuses[blocking.approvalId] !== "pending" ||
            this.approvalItems[blocking.approvalId] !== blocking.itemId
          ) {
            throw new LifecycleTransitionError(
              "approval",
              "missing",
              "pending",
              "blocking approval does not match a pending approval request",
            );
          }
          if (previousStatus !== "awaiting_approval")
            previousStatus = transitionTurnStatus(previousStatus, "awaiting_approval");
        } else if (previousStatus === "awaiting_approval") {
          previousStatus = transitionTurnStatus(previousStatus, "in_progress");
        }
        if ((blocking.kind !== "none" && !this.isPendingBlocking(blocking)) ||
            (blocking.kind === "none" && this.selectPendingBlocking().kind !== "none"))
          throw new LifecycleTransitionError("turn", previousStatus, blocking.kind, "Blocking focus does not match pending canonical requests");
        this.blockingState = blocking;
      } else if (event.type === "run_attempt.started") {
        if (!started) {
          throw new LifecycleTransitionError(
            "run_attempt",
            "turn_not_started",
            "running",
            "run attempt cannot start before its turn",
          );
        }
        this.runAttemptStatus = transitionRunAttemptStatus(
          this.runAttemptStatus,
          "running",
        );
      } else if (
        event.type === "run_attempt.succeeded" ||
        event.type === "run_attempt.failed" ||
        event.type === "run_attempt.interrupted"
      ) {
        const next =
          event.type === "run_attempt.succeeded"
            ? "succeeded"
            : event.type === "run_attempt.failed"
              ? "failed"
              : "interrupted";
        this.runAttemptStatus = transitionRunAttemptStatus(
          this.runAttemptStatus,
          next,
        );
      } else if (event.type === "item.started") {
        const kind = ItemKindSchema.parse(event.payload.kind);
        if (this.itemStatuses[event.itemId]) {
          throw new LifecycleTransitionError(
            "item",
            this.itemStatuses[event.itemId]!,
            "active",
            `item ${event.itemId} was started more than once`,
          );
        }
        this.itemStatuses[event.itemId] = transitionItemStatus(
          "not_started",
          "active",
        );
        this.itemKinds[event.itemId] = kind;
        if (kind === "approval_request") {
          const parentItemId = event.payload.parentItemId;
          if (parentItemId) {
            this.approvalParents[event.itemId] = parentItemId;
          }
        }
      } else if (
        event.type === "item.completed" ||
        event.type === "item.failed" ||
        event.type === "item.declined" ||
        event.type === "item.interrupted"
      ) {
        const status = event.type.slice("item.".length) as Exclude<
          ItemStatus,
          "not_started" | "active"
        >;
        const current = this.itemStatuses[event.itemId] ?? "not_started";
        this.itemStatuses[event.itemId] = transitionItemStatus(current, status);
      } else if (event.type === "tool_call.started") {
        if (
          this.toolCallStatuses[event.toolCallId] ||
          this.itemStatuses[event.itemId] !== "active" ||
          this.itemKinds[event.itemId] !== "tool_call"
        ) {
          throw new LifecycleTransitionError(
            "tool_call",
            this.toolCallStatuses[event.toolCallId] ?? "missing",
            "active",
            `tool call ${event.toolCallId} has no fresh active item`,
          );
        }
        this.toolCallStatuses[event.toolCallId] = transitionToolCallStatus(
          "not_started",
          "active",
        );
        this.toolCallItems[event.toolCallId] = event.itemId;
        if (event.payload.toolName) this.toolCallNames[event.toolCallId] = event.payload.toolName;
        if (event.payload.callBatchId) this.toolCallBatches[event.toolCallId] = event.payload.callBatchId;
      } else if (
        event.type === "tool_call.input_delta" ||
        event.type === "tool_call.output_delta"
      ) {
        if (
          this.toolCallStatuses[event.toolCallId] !== "active" ||
          this.toolCallItems[event.toolCallId] !== event.itemId
        ) {
          throw new LifecycleTransitionError(
            "tool_call",
            this.toolCallStatuses[event.toolCallId] ?? "missing",
            "active",
            `tool call ${event.toolCallId} is not active on its owning item`,
          );
        }
      } else if (
        event.type === "tool_call.completed" ||
        event.type === "tool_call.failed" ||
        event.type === "tool_call.declined" ||
        event.type === "tool_call.interrupted"
      ) {
        if (this.toolCallItems[event.toolCallId] !== event.itemId) {
          throw new LifecycleTransitionError(
            "tool_call",
            "missing",
            event.type,
            `tool call ${event.toolCallId} has no matching owner item`,
          );
        }
        const status = event.type.slice("tool_call.".length) as Exclude<
          ToolCallStatus,
          "not_started" | "active"
        >;
        this.toolCallStatuses[event.toolCallId] = transitionToolCallStatus(
          this.toolCallStatuses[event.toolCallId] ?? "not_started",
          status,
        );
      } else if (event.type === "approval.requested") {
        if (
          this.itemStatuses[event.itemId] !== "active" ||
          this.approvalStatuses[event.approvalId]
        ) {
          throw new LifecycleTransitionError(
            "approval",
            this.approvalStatuses[event.approvalId] ?? "missing",
            "pending",
            `approval ${event.approvalId} has no fresh active request item`,
          );
        }
        this.approvalStatuses[event.approvalId] = "pending";
        this.approvalItems[event.approvalId] = event.itemId;
      } else if (event.type === "approval.decided") {
        const current = this.approvalStatuses[event.approvalId];
        if (!current || this.approvalItems[event.approvalId] !== event.itemId) {
          throw new LifecycleTransitionError(
            "approval",
            "missing",
            String(event.payload.status),
            `approval ${event.approvalId} has no matching request`,
          );
        }
        this.approvalStatuses[event.approvalId] = transitionApprovalStatus(
          current,
          event.payload.status,
        );
      } else if (!requireIsolatedApproval && event.type === "user_input.requested") {
        if (this.userInputItems[event.requestId] || this.itemStatuses[event.itemId] !== "active" || this.itemKinds[event.itemId] !== "user_input_request")
          throw new LifecycleTransitionError("item", "inactive", "requested", "Recovered question has no fresh active request item");
        this.userInputItems[event.requestId] = event.itemId;
        this.userInputStatuses[event.requestId] = "pending";
      } else if (!requireIsolatedApproval && (event.type === "user_input.responded" ||
          (event.type === "request.resolved" && this.userInputItems[event.requestId]))) {
        if (this.userInputItems[event.requestId] !== event.itemId || this.userInputStatuses[event.requestId] !== "pending" || this.itemStatuses[event.itemId] !== "active")
          throw new LifecycleTransitionError("item", "inactive", "resolved", "Recovered question resolution has no pending canonical request");
        this.userInputStatuses[event.requestId] = event.type === "user_input.responded" ? "responded" : "cancelled";
      } else if (!requireIsolatedApproval && event.type === "turn.input.applied") {
        if (this.acceptedInputSequences.get(event.payload.inputId) !== event.payload.acceptedSequence) throw new Error("Recovered input application has no matching canonical acceptance");
        this.appliedInputs.set(event.payload.inputId, { ...event.payload, sequence: event.sequence });
      } else if (!requireIsolatedApproval && event.type === "turn.input.accepted") {
        this.acceptedInputSequences.set(event.payload.inputId, event.sequence);
      } else if (requireIsolatedApproval && (
        event.type.startsWith("user_input.") ||
        event.type === "request.resolved" ||
        event.type === "context_compaction.requested" ||
        event.type === "context_compaction.started" ||
        event.type.startsWith("hook.invocation.")
      )) {
        throw new LifecycleTransitionError(
          "turn",
          event.type,
          "awaiting_approval",
          "history contains another pending runtime owner",
        );
      }

      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
        if (requireIsolatedApproval) throw new LifecycleTransitionError("turn", event.type, "awaiting_approval", "terminal history cannot be restored for interruption");
        const outcome = event.payload.outcome;
        previousStatus = transitionTurnStatus(previousStatus, outcome.status);
        this.terminalOutcome = outcome.status;
        validateTerminalSettlement({ turnStatus: previousStatus, terminalOutcome: outcome,
          blockingState: this.blockingState, itemStatuses: this.itemStatuses, approvalStatuses: this.approvalStatuses });
      }
      this.sequence = event.sequence;
      lastEvent = event;
    }

    if (!requireIsolatedApproval) {
      if (!this.accepted || !started) throw new Error("Harness recovery requires canonical turn/start evidence");
      this.status = previousStatus;
      return;
    }

    const pendingApprovals = Object.entries(this.approvalStatuses).filter(
      ([, status]) => status === "pending",
    );
    const pendingApproval = pendingApprovals[0];
    const pendingApprovalId = pendingApproval?.[0];
    const pendingApprovalItemId = pendingApprovalId
      ? this.approvalItems[pendingApprovalId]
      : undefined;
    const approvalParent = pendingApprovalItemId
      ? this.approvalParents[pendingApprovalItemId]
      : undefined;
    const activeToolCalls = Object.entries(this.toolCallStatuses).filter(
      ([, status]) => status === "active",
    );
    const activeItems = Object.entries(this.itemStatuses)
      .filter(([, status]) => status === "active")
      .map(([itemId]) => itemId);
    if (
      !this.accepted ||
      !started ||
      this.runAttemptStatus !== "running" ||
      previousStatus !== "awaiting_approval" ||
      this.blockingState.kind !== "waiting_for_approval" ||
      pendingApprovals.length !== 1 ||
      !pendingApprovalId ||
      !pendingApprovalItemId ||
      this.blockingState.approvalId !== pendingApprovalId ||
      this.blockingState.itemId !== pendingApprovalItemId ||
      !approvalParent ||
      activeToolCalls.length !== 1 ||
      activeToolCalls.some(
        ([toolCallId]) => this.toolCallItems[toolCallId] !== approvalParent,
      ) ||
      activeItems.length !== activeToolCalls.length + 1 ||
      !activeItems.includes(approvalParent) ||
      this.itemKinds[approvalParent] !== "tool_call" ||
      this.itemKinds[pendingApprovalItemId] !== "approval_request" ||
      !activeItems.includes(pendingApprovalItemId) ||
      lastEvent?.type !== "turn.blocking_changed"
    ) {
      throw new LifecycleTransitionError(
        "turn",
        previousStatus,
        "awaiting_approval",
        "history does not prove an isolated pending approval gate",
      );
    }
    this.status = previousStatus;
  }

  /** Terminal append is the linearization point. An ambiguous append keeps this
   * outcome frozen for durable recovery rather than attempting a conflicting one. */
  get isTerminalDecided(): boolean { return this.isTerminal || this.terminalOutcome !== null; }

  get terminalStatus(): "completed" | "interrupted" | "failed" | null {
    return this.status === "completed" || this.status === "interrupted" || this.status === "failed" ? this.status : null;
  }

  get isTerminal(): boolean {
    return this.terminalStatus !== null;
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
      this.createEvent(
        {
          type: "turn.started",
          payload: {
            ...(this.options.revisionOfTurnId
              ? { revisionOfTurnId: this.options.revisionOfTurnId }
              : {}),
            ...(this.options.continuationOfTurnId
              ? { continuationOfTurnId: this.options.continuationOfTurnId }
              : {}),
            ...(this.options.originalPromptId
              ? { originalPromptId: this.options.originalPromptId }
              : {}),
          },
        },
        2,
      ),
      this.createEvent({ type: "run_attempt.started", payload: this.options.executionCapability ? { executionCapability: this.options.executionCapability } : {} }, 3),
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
    toolName: string,
    input: JsonRecord,
    callBatchId?: import("@repo/platform-protocol").ToolCallBatchId,
    display?: LifecycleToolDisplay,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.startToolCallNow(itemId, toolCallId, toolName, input, callBatchId, display),
    );
  }

  async appendAssistantCommentary(itemId: ItemId, text: string): Promise<void> {
    if (!text.trim()) return;
    await this.enqueue(async () => {
      await this.startItem(itemId, "commentary", {});
      for (const delta of splitLifecycleOutput(text)) {
        await this.emit({
          type: "assistant_message.delta",
          itemId,
          payload: { phase: "commentary", delta },
        });
      }
      await this.settleItem(itemId, "completed", { result: {} });
    });
  }

  async appendAssistantReasoning(
    itemId: ItemId,
    text: string,
    displaySafe: boolean,
  ): Promise<void> {
    if (!displaySafe || !text.trim()) return;
    await this.enqueue(async () => {
      await this.startItem(itemId, "reasoning", {});
      for (const delta of splitLifecycleOutput(text)) {
        await this.emit({
          type: "reasoning.summary_delta",
          itemId,
          payload: { delta, displaySafe: true },
        });
      }
      await this.settleItem(itemId, "completed", { result: {} });
    });
  }

  private async startToolCallNow(
    itemId: ItemId,
    toolCallId: ToolCallId,
    toolName: string,
    input: JsonRecord,
    callBatchId?: import("@repo/platform-protocol").ToolCallBatchId,
    display?: LifecycleToolDisplay,
  ): Promise<void> {
    await this.startItem(itemId, "tool_call", display ? { display } : {});
    const next = transitionToolCallStatus("not_started", "active");
    await this.emit({
      type: "tool_call.started",
      itemId,
      toolCallId,
      payload: { toolName, ...(callBatchId ? { callBatchId } : {}), ...(display ? { display } : {}) },
    });
    this.toolCallStatuses[toolCallId] = next;
    this.toolCallNames[toolCallId] = toolName;
    if (callBatchId) this.toolCallBatches[toolCallId] = callBatchId;
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

  async markWorkspaceSnapshotUnavailable(
    reason: ResumeWorkspaceUnavailableReason,
  ): Promise<void> {
    await this.enqueue(async () =>
      this.emit({
        type: "workspace.snapshot_unavailable",
        payload: { reason },
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

  async recordHarnessActivity(payload: HarnessActivityMeasuredPayload): Promise<void> {
    this.assertHarnessMeasurementScope(payload.measurement);
    await this.enqueue(async () => this.emit({
      type: "harness.activity_measured", payload,
    }));
  }

  async recordHarnessProviderLimit(payload: HarnessProviderLimitNotifiedPayload): Promise<void> {
    this.assertHarnessMeasurementScope(payload.notification);
    await this.enqueue(async () => this.emit({
      type: "harness.provider_limit_notified", payload,
    }));
  }

  private assertHarnessMeasurementScope(value: { threadId: ThreadId; turnId: TurnId; runAttemptId: RunAttemptId }): void {
    if (value.threadId !== this.options.threadId || value.turnId !== this.options.turnId || value.runAttemptId !== this.options.runAttemptId)
      throw new Error("Harness measurement does not belong to this canonical attempt");
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
    if (payload.phase === "failed") {
      payload = {
        ...payload,
        error: toPublicProtocolError({ code: "command_failed" }).message,
      };
    }
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
          : {
              result: {
                preservedContextReference: payload.preservedContextReference,
              },
            },
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
    const publicFailure = toPublicProtocolError(failure);
    await this.enqueue(async () =>
      this.settleToolCall(toolCallId, "failed", { failure: publicFailure }),
    );
  }

  async declineToolCall(toolCallId: ToolCallId, _reason: string): Promise<void> {
    // Caller diagnostics never become the public catalog reason.
    void _reason;
    const reason = toPublicProtocolError({ code: "policy_denied" }).message;
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
    await this.changeBlocking(this.selectPendingBlocking());
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
    await this.changeBlocking(this.selectPendingBlocking());
    const itemId = this.requireApprovalItem(approvalId);
    await this.settleItem(
      itemId,
      status === "approved" ? "completed" : "declined",
      status === "approved" ? { result: {} } : { reason: `Approval ${status}` },
    );
  }

  async requestUserInput(itemId: ItemId, requestId: string, payload: JsonRecord): Promise<void> {
    await this.enqueue(async () => {
      if (this.userInputItems[requestId]) {
        throw new LifecycleTransitionError("item", "active", "requested", "User input request conflicts with an active request");
      }
      await this.startItem(itemId, "user_input_request", {});
      await this.emit({ type: "user_input.requested", itemId, requestId, payload });
      this.userInputItems[requestId] = itemId;
      this.userInputStatuses[requestId] = "pending";
      await this.changeBlocking(this.selectPendingBlocking());
    });
  }

  /** Exact native withdrawal, staged inside the canonical observation transaction. */
  async withdrawHarnessRequest(input: {
    readonly requestType: "approval" | "user_input";
    readonly itemId: ItemId;
    readonly requestId: string;
    readonly reason: "native_rejected" | "native_cancelled";
  }): Promise<void> {
    await this.enqueue(async () => {
      if (input.requestType === "approval") {
        const approvalId = input.requestId as ApprovalId;
        if (this.approvalItems[approvalId] !== input.itemId || this.approvalStatuses[approvalId] !== "pending")
          throw new LifecycleTransitionError("item", "inactive", "cancelled", "Native withdrawal does not match a pending approval");
        await this.emit({ type: "approval.decided", itemId: input.itemId, approvalId,
          payload: { status: "cancelled", decidedBy: null, reason: "Native request withdrawn" } });
        this.approvalStatuses[approvalId] = "cancelled";
        await this.settleItem(input.itemId, "declined", { reason: "Native request withdrawn" });
        await this.changeBlocking(this.selectPendingBlocking());
      } else {
        if (this.userInputItems[input.requestId] !== input.itemId || this.userInputStatuses[input.requestId] !== "pending" || this.itemStatuses[input.itemId] !== "active")
          throw new LifecycleTransitionError("item", "inactive", "cancelled", "Native withdrawal does not match a pending question");
        await this.emit({ type: "request.resolved", itemId: input.itemId, requestId: input.requestId,
          payload: { status: "cancelled", reason: input.reason } });
        this.userInputStatuses[input.requestId] = "cancelled";
        await this.settleItem(input.itemId, "interrupted", { reason: "Native request withdrawn" });
        await this.changeBlocking(this.selectPendingBlocking());
      }
    });
  }

  async respondUserInput(requestId: string, response: JsonRecord, respondedBy: import("@repo/platform-protocol").UserId | null): Promise<void> {
    await this.enqueue(async () => {
      const itemId = this.userInputItems[requestId];
      if (!itemId || this.itemStatuses[itemId] !== "active" || this.userInputStatuses[requestId] !== "pending") {
        throw new LifecycleTransitionError("item", "inactive", "responded", "User input request is no longer pending");
      }
      await this.emit({ type: "user_input.responded", itemId, requestId, payload: { response, respondedBy } });
      this.userInputStatuses[requestId] = "responded";
      await this.settleItem(itemId, "completed", { result: {} });
      await this.changeBlocking(this.selectPendingBlocking());
    });
  }

  async complete(output: string, itemId: ItemId, canComplete: () => boolean = () => true): Promise<void> {
    await this.enqueue(async () => this.completeNow(output, itemId, canComplete));
  }

  async acceptThreadInput(input: {
    readonly inputId: string;
    readonly clientInputId: string;
    readonly transcriptMessageId: string;
  }, afterAppend: (acceptedSequence: number) => void, canAccept: () => boolean = () => true, fenceOnAppendFailure = false): Promise<number> {
    let acceptedSequence: number | undefined;
    await this.enqueue(async () => {
      const existingSequence = this.acceptedInputSequences.get(input.inputId);
      if (existingSequence !== undefined) {
        acceptedSequence = existingSequence;
        return;
      }
      if (this.completionReserved || this.isTerminalDecided || !canAccept()) {
        throw new LifecycleTransitionError(
          "turn",
          this.status,
          "turn.input.accepted",
          "the turn is already settling",
        );
      }
      try {
        await this.emit({ type: "turn.input.accepted", payload: input });
      } catch (error) {
        if (fenceOnAppendFailure) this.harnessFenced = true;
        throw error;
      }
      acceptedSequence = this.sequence;
      this.acceptedInputSequences.set(input.inputId, this.sequence);
      afterAppend(this.sequence);
    });
    if (acceptedSequence === undefined) {
      throw new Error("Accepted thread input did not append a lifecycle event.");
    }
    return acceptedSequence;
  }

  hasPendingThreadInputs(): boolean {
    return [...this.acceptedInputSequences.keys()].some((inputId) => !this.appliedInputs.has(inputId));
  }

  async reserveCompletion(hasPendingInputs: () => boolean): Promise<boolean> {
    let reserved = false;
    await this.enqueue(async () => {
      if (this.isTerminal || this.completionReserved || hasPendingInputs()) return;
      this.completionReserved = true;
      reserved = true;
    });
    return reserved;
  }

  async applyThreadInput(input: {
    readonly inputId: string;
    readonly acceptedSequence: number;
    readonly modelStep: number;
    readonly contextRevision: number;
  }): Promise<number> {
    let appliedSequence: number | undefined;
    await this.enqueue(async () => {
      if (this.acceptedInputSequences.get(input.inputId) !== input.acceptedSequence) {
        throw new LifecycleTransitionError("turn", "input_not_accepted", "input_applied", "Input application does not match canonical acceptance");
      }
      const prior = this.appliedInputs.get(input.inputId);
      if (prior) {
        if (prior.modelStep !== input.modelStep || prior.contextRevision !== input.contextRevision) throw new LifecycleTransitionError("turn", "input_applied", "input_applied", "Conflicting input application evidence");
        appliedSequence = prior.sequence;
        return;
      }
      await this.emit({ type: "turn.input.applied", payload: input });
      appliedSequence = this.sequence;
      this.appliedInputs.set(input.inputId, { ...input, sequence: this.sequence });
    });
    if (appliedSequence === undefined) {
      throw new Error("Applied thread input did not append a lifecycle event.");
    }
    return appliedSequence;
  }

  private async completeNow(output: string, itemId: ItemId, canComplete: () => boolean): Promise<void> {
    this.assertCompletionAllowed(canComplete);
    await this.startItem(itemId, "assistant_message", {});
    for (const delta of splitLifecycleOutput(output)) {
      await this.emit({
        type: "assistant_message.delta",
        itemId,
        payload: { phase: "final_answer", delta },
      });
    }
    await this.settleItem(itemId, "completed", { result: { output } });
    this.assertCompletionAllowed(canComplete);
    await this.settleTurn({ status: "completed" });
  }

  private assertCompletionAllowed(canComplete: () => boolean): void {
    if (!canComplete()) throw new LifecycleTransitionError("turn", "interrupted", "completed", "Stop was accepted before terminal settlement");
  }

  async fail(failure: ProtocolError): Promise<void> {
    const publicFailure = toPublicProtocolError(failure);
    await this.enqueue(async () => this.failNow(publicFailure));
  }

  private async failNow(failure: ProtocolError): Promise<void> {
    await this.cancelPendingApprovals("Turn failed before approval resolution");
    await this.cancelPendingUserInput("Turn failed before user input");
    await this.settleOpenWork("failed", { failure });
    await this.settleTurn({ status: "failed", failure });
  }

  async interrupt(_reason: string): Promise<void> {
    // Preserve the command signature without publishing caller diagnostics.
    void _reason;
    const reason = toPublicProtocolError({ code: "command_cancelled" }).message;
    await this.enqueue(async () => this.interruptNow(reason));
  }

  private async interruptNow(reason: string): Promise<void> {
    await this.cancelPendingApprovals(reason);
    await this.cancelPendingUserInput(reason);
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
    const metadata = {
      ...(this.toolCallNames[toolCallId] ? { toolName: this.toolCallNames[toolCallId] } : {}),
      ...(this.toolCallBatches[toolCallId] ? { callBatchId: this.toolCallBatches[toolCallId] } : {}),
    };
    await this.emit({
      type: `tool_call.${status}`,
      itemId,
      toolCallId,
      payload: { ...payload, ...metadata },
    });
    this.toolCallStatuses[toolCallId] = next;
    // Tool identity belongs to the tool_call event. item.* payloads retain
    // their established result/failure shape and remain strict at the protocol boundary.
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

  private async cancelPendingUserInput(reason: string): Promise<void> {
    for (const [requestId, itemId] of Object.entries(this.userInputItems)) {
      if (this.userInputStatuses[requestId] === "pending" && this.itemStatuses[itemId] === "active") {
        await this.emit({ type: "request.resolved", itemId, requestId, payload: { status: "cancelled", reason } });
        this.userInputStatuses[requestId] = "cancelled";
      }
    }
    await this.changeBlocking(this.selectPendingBlocking());
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
    this.terminalOutcome = outcome.status;
    await this.appendTerminalBatch(events, outcome.status);
    this.sequence += events.length;
    this.runAttemptStatus = nextAttempt;
    this.status = nextTurn;
  }

  /** Focus is a projection of canonical pending membership, never its owner. */
  private isPendingBlocking(blocking: TurnBlockingState): boolean {
    if (blocking.kind === "waiting_for_approval")
      return this.approvalStatuses[blocking.approvalId] === "pending" &&
        this.approvalItems[blocking.approvalId] === blocking.itemId && this.itemStatuses[blocking.itemId] === "active";
    if (blocking.kind === "waiting_for_user_input")
      return this.userInputStatuses[blocking.requestId] === "pending" &&
        this.userInputItems[blocking.requestId] === blocking.itemId && this.itemStatuses[blocking.itemId] === "active";
    return false;
  }

  private selectPendingBlocking(): TurnBlockingState {
    if (this.isPendingBlocking(this.blockingState)) return this.blockingState;
    for (const [approvalId, status] of Object.entries(this.approvalStatuses)) {
      const itemId = this.approvalItems[approvalId];
      if (status === "pending" && itemId && this.itemStatuses[itemId] === "active")
        return { kind: "waiting_for_approval", approvalId: approvalId as ApprovalId, itemId };
    }
    for (const [requestId, itemId] of Object.entries(this.userInputItems)) {
      if (this.userInputStatuses[requestId] === "pending" && this.itemStatuses[itemId] === "active")
        return { kind: "waiting_for_user_input", requestId, itemId };
    }
    return { kind: "none" };
  }

  private async changeBlocking(blockingState: TurnBlockingState): Promise<void> {
    if (JSON.stringify(blockingState) === JSON.stringify(this.blockingState)) return;
    // Validate before append; focus-only updates do not transition turn status.
    const nextStatus = blockingState.kind === "waiting_for_approval"
      ? (this.status === "awaiting_approval" ? this.status : transitionTurnStatus(this.status, "awaiting_approval"))
      : (this.status === "awaiting_approval" ? transitionTurnStatus(this.status, "in_progress") : this.status);
    if ((blockingState.kind !== "none" && !this.isPendingBlocking(blockingState)) ||
        (blockingState.kind === "none" && this.selectPendingBlocking().kind !== "none"))
      throw new LifecycleTransitionError("turn", this.status, blockingState.kind, "Blocking focus does not match pending canonical requests");
    await this.emit({ type: "turn.blocking_changed", payload: { blockingState } });
    this.status = nextStatus;
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
    const guarded = async () => {
      if (this.harnessFenced) throw new Error("Harness lifecycle is fenced pending canonical replay recovery");
      return operation();
    };
    const result = this.operationQueue.then(guarded, guarded);
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

function splitLifecycleOutput(output: string): string[] {
  if (output.length === 0) return [""];
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < output.length;
    offset += MAX_LIFECYCLE_OUTPUT_LENGTH
  ) {
    chunks.push(output.slice(offset, offset + MAX_LIFECYCLE_OUTPUT_LENGTH));
  }
  return chunks;
}
