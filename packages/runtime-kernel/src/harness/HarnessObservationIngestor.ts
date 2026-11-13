import type { HarnessSelection, ToolCallId } from "@repo/platform-protocol";
import {
  HarnessCommitAckSchema,
  HarnessObservationPayloadSchema,
  HarnessQuiescenceSchema,
  HarnessObservationSchema,
  type HarnessCommitAck,
  type HarnessObservation,
  type HarnessSession,
} from "@repo/worker-protocol";
import { RuntimeLifecycleCoordinator } from "../RuntimeLifecycleCoordinator.js";
import { RuntimeKernelError } from "../errors.js";
import type { HarnessObservationCommitPort } from "./DelegatedHarnessPort.js";

export function sameHarnessSession(
  a: HarnessSession,
  b: HarnessSession,
): boolean {
  return (
    a.runAttemptId === b.runAttemptId &&
    a.instanceId === b.instanceId &&
    a.externalSessionId === b.externalSessionId &&
    a.processGeneration === b.processGeneration
  );
}

type Terminal = Extract<
  HarnessObservation["payload"],
  { kind: "external_terminal" }
>;
type UserInput = Extract<
  HarnessObservation["payload"],
  { kind: "user_input_requested" }
>;
type Approval = Extract<
  HarnessObservation["payload"],
  { kind: "approval_requested" }
>;

/** Private ingress validates before translation. Persistence owns replay/deduplication. */
export class HarnessObservationIngestor {
  private readonly tools = new Map<string, ToolCallId>();
  private externalTurnId: string | null = null;
  private terminal: Terminal | null = null;
  private toolCount = 0;
  private quiescent = false;
  private initialized: Promise<void> | null = null;
  private fenced = false;
  private lastSequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  // Notification receipts survive rehydration within this ingress owner. They
  // are not reply claims: persistence still owns single-use reply delivery.
  private readonly requestOrigins = new Set<string>();
  private readonly pendingRequests = new Map<string, Approval | UserInput>();

  constructor(
    private readonly options: {
      readonly selection: HarnessSelection;
      readonly session: HarnessSession;
      readonly lifecycle: RuntimeLifecycleCoordinator;
      readonly persistence: HarnessObservationCommitPort;
      readonly onApproval: (approval: Approval) => void;
      readonly onUserInput: (request: UserInput) => void;
      readonly onWithdrawal: (request: Extract<HarnessObservation["payload"], { kind: "request_withdrawn" }>) => {
        committed(): void;
        failed(error: unknown): void;
      };
    },
  ) {}

  async ready(): Promise<void> {
    this.initialized ??= this.hydrate().catch((error: unknown) => {
      this.fenced = true;
      throw error;
    });
    await this.initialized;
    if (this.fenced)
      this.reject("Harness ingress is fenced pending durable recovery");
  }

  get steeringTarget(): string | null {
    return this.terminal || this.quiescent || this.fenced
      ? null
      : this.externalTurnId;
  }

  get hasPriorIngress(): boolean {
    return this.lastSequence > 0;
  }

  private async hydrate(): Promise<void> {
    const recovered = await this.options.persistence.recover(
      this.options.session,
    );
    if (
      !sameHarnessSession(recovered.session, this.options.session) ||
      !Number.isSafeInteger(recovered.lastSequence) ||
      recovered.lastSequence < 0
    )
      this.reject("Recovery binding identity mismatch");
    await this.options.lifecycle.restoreHarnessHistory(
      recovered.lifecycleEvents,
    );
    this.tools.clear();
    this.toolCount = 0;
    this.terminal = null;
    this.quiescent = false;
    this.lastSequence = recovered.lastSequence;
    this.externalTurnId = recovered.externalTurnId;
    for (const event of recovered.lifecycleEvents) {
      if (event.type === "tool_call.started") {
        this.tools.set(event.itemId, event.toolCallId);
        this.toolCount += 1;
      }
      if (
        [
          "tool_call.completed",
          "tool_call.failed",
          "tool_call.declined",
          "tool_call.interrupted",
        ].includes(event.type) &&
        "itemId" in event &&
        typeof event.itemId === "string"
      )
        this.tools.delete(event.itemId);
    }
    if (recovered.terminal) {
      const terminal = HarnessObservationPayloadSchema.parse(
        recovered.terminal,
      );
      if (terminal.kind !== "external_terminal")
        this.reject("Recovery terminal fact is malformed");
      this.terminal = terminal;
    }
    if (recovered.quiescence) {
      const evidence = HarnessQuiescenceSchema.parse(recovered.quiescence);
      if (!sameHarnessSession(evidence.session, this.options.session))
        this.reject("Recovery quiescence identity mismatch");
      this.quiescent = evidence.status === "quiescent";
    }
    this.pendingRequests.clear();
    for (const input of recovered.pendingRequests) {
      const request = HarnessObservationPayloadSchema.parse(input);
      if (
        request.kind !== "approval_requested" &&
        request.kind !== "user_input_requested"
      )
        this.reject("Recovery request fact is malformed");
      if (
        !sameHarnessSession(request.replyTo.session, this.options.session) ||
        request.replyTo.authOwnerGeneration !==
          this.options.selection.authOwnerGeneration
      )
        this.reject("Recovery request has a stale origin");
      this.pendingRequests.set(JSON.stringify(request.replyTo), request);
      this.notifyRequest(request);
    }
  }

  get toolCallCount(): number {
    return this.toolCount;
  }

  get terminalObservation(): Terminal | null {
    return this.terminal;
  }

  async observe(input: unknown): Promise<HarnessCommitAck> {
    // Serialize translation and post-commit effects, including callers that fail
    // to await delivery. The host must separately bound its delivery journal.
    if (this.pending >= 64)
      this.reject("Harness ingress buffer is full; delivery must pause");
    const observation = HarnessObservationSchema.parse(input);
    this.pending += 1;
    const operation = this.queue
      .then(async () => {
        await this.ready();
        return this.ingest(observation);
      })
      .catch((error: unknown) => {
        // A failed post-commit callback or ambiguous commit cannot be repaired by
        // ACKing a duplicate and skipping the lost canonical/pending state.
        if (this.options.lifecycle.requiresHarnessRecovery) this.fenced = true;
        throw error;
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async ingest(input: unknown): Promise<HarnessCommitAck> {
    const observation = HarnessObservationSchema.parse(input);
    const { session, selection, persistence, lifecycle } = this.options;
    if (!sameHarnessSession(observation.session, session))
      this.reject("Stale harness observation session");
    // This lookup validates immutable payload fingerprint as well as identity.
    // A committed duplicate can be ACKed even after terminal settlement.
    const existing = await persistence.lookup(observation);
    if (existing) {
      if (observation.sequence > this.lastSequence) {
        this.fenced = true;
        this.reject(
          "Committed ingress is ahead of hydrated state; recover before ACK",
        );
      }
      return this.validateAck(existing, observation);
    }
    if (observation.sequence !== this.lastSequence + 1)
      this.reject(
        "Observation sequence gap or missing immutable ingress identity",
      );
    if (this.quiescent) this.reject("Observation follows proven quiescence");
    if (
      this.terminal &&
      observation.payload.kind !== "quiescence" &&
      !(
        "background" in observation.payload &&
        observation.payload.background === true
      )
    ) {
      this.reject(
        "Only explicit background work may follow foreground terminal",
      );
    }
    if (
      this.externalTurnId !== null &&
      observation.externalTurnId !== this.externalTurnId
    )
      this.reject("External turn identity changed");
    const payload = observation.payload;
    if (
      payload.kind === "approval_requested" ||
      payload.kind === "user_input_requested"
    ) {
      if (this.requestOrigins.has(JSON.stringify(payload.replyTo)))
        this.reject("Approval request origin was reused");
      if (
        !sameHarnessSession(payload.replyTo.session, session) ||
        payload.replyTo.authOwnerGeneration !== selection.authOwnerGeneration
      )
        this.reject("Stale approval origin");
      if (
        payload.kind === "approval_requested" &&
        (payload.request.itemId === null ||
          payload.request.itemId === payload.parentItemId)
      )
        this.reject("Invalid approval item");
    }
    if (
      payload.kind === "quiescence" &&
      !sameHarnessSession(payload.evidence.session, session)
    )
      this.reject("Stale quiescence evidence");
    if (payload.kind === "activity_measurement" || payload.kind === "provider_limit") {
      const fact = payload.kind === "activity_measurement" ? payload.measurement : payload.notification;
      if (
        fact.threadId !== selection.threadId ||
        fact.turnId !== selection.turnId ||
        fact.runAttemptId !== session.runAttemptId ||
        fact.instanceId !== session.instanceId ||
        fact.externalSessionId !== session.externalSessionId ||
        fact.processGeneration !== session.processGeneration
      ) this.reject("Measurement identity differs from the admitted process binding");
    }
    let withdrawal: ReturnType<NonNullable<typeof this.options.onWithdrawal>> | undefined;
    if (payload.kind === "request_withdrawn") {
      const origin = JSON.stringify(payload.replyTo);
      const pending = this.pendingRequests.get(origin);
      const matches = pending && sameHarnessSession(payload.replyTo.session, session) &&
        payload.replyTo.authOwnerGeneration === selection.authOwnerGeneration &&
        (pending.kind === "approval_requested"
          ? payload.requestType === "approval" && pending.request.approvalId === payload.requestId && pending.request.itemId === payload.itemId
          : payload.requestType === "user_input" && pending.requestId === payload.requestId && pending.itemId === payload.itemId);
      if (!matches) { this.fenced = true; this.reject("Native withdrawal does not match a pending canonical request"); }
      try { withdrawal = this.options.onWithdrawal(payload); }
      catch (error) { this.fenced = true; throw error; }
    }
    let applied = false;
    const ack = await lifecycle.commitHarnessObservation(
      observation,
      persistence,
      async (draft) => {
        applied = true;
        switch (payload.kind) {
          case "thread_input_applied":
            await draft.applyThreadInput(payload.input);
            break;
          case "assistant_text":
            await draft.appendAssistantCommentary(payload.itemId, payload.text);
            break;
          case "tool_started":
            await draft.startToolCall(
              payload.itemId,
              payload.content.toolCallId,
              payload.content.toolName,
              payload.content.input,
            );
            break;
          case "tool_completed": {
            const tool = this.tools.get(payload.itemId);
            if (!tool) this.reject("Tool completion has no matching start");
            await draft.appendToolOutput(tool, payload.output);
            await draft.completeToolCall(tool, { output: payload.output });
            break;
          }
          case "tool_failed": {
            const tool = this.tools.get(payload.itemId);
            if (!tool) this.reject("Tool failure has no matching start");
            await draft.failToolCall(tool, payload.failure);
            break;
          }
          case "request_withdrawn":
            await draft.withdrawHarnessRequest(payload);
            break;
          case "user_input_requested":
            await draft.requestUserInput(
              payload.itemId,
              payload.requestId,
              payload.payload,
            );
            break;
          case "approval_requested":
            await draft.requestApproval(
              payload.parentItemId,
              payload.request.approvalId,
              payload.request.itemId!,
              {
                question: payload.request.question,
                options: payload.request.options,
                metadata: payload.request.metadata,
              },
            );
            break;
          case "activity_measurement":
            await draft.recordHarnessActivity({ measurement: payload.measurement });
            break;
          case "provider_limit":
            await draft.recordHarnessProviderLimit({ notification: payload.notification });
            break;
          case "usage":
            await draft.updateUsage(payload.usage);
            break;
          // External terminal/quiescence are durable ingress evidence. They never
          // independently decide canonical turn success or release the lease.
          case "external_terminal":
          case "quiescence":
            break;
        }
      },
    ).catch((error: unknown) => {
      if (withdrawal) { this.fenced = true; withdrawal.failed(error); }
      throw error;
    });
    this.validateAck(ack, observation);
    withdrawal?.committed();
    if (payload.kind === "request_withdrawn") this.pendingRequests.delete(JSON.stringify(payload.replyTo));
    if (!applied && observation.sequence > this.lastSequence) {
      // Another initialized owner committed between the two immutable lookups.
      // Restore every canonical/pending/terminal fact before acknowledging it.
      this.fenced = true;
      await this.hydrate();
      if (this.lastSequence < observation.sequence)
        this.reject("Commit-time duplicate is ahead of canonical recovery");
      this.fenced = false;
    }
    if (applied) {
      this.lastSequence = observation.sequence;
      this.externalTurnId ??= observation.externalTurnId;
      if (payload.kind === "tool_started") {
        this.tools.set(payload.itemId, payload.content.toolCallId);
        this.toolCount += 1;
      }
      if (payload.kind === "tool_completed" || payload.kind === "tool_failed")
        this.tools.delete(payload.itemId);
      if (payload.kind === "external_terminal") this.terminal = payload;
      if (
        payload.kind === "quiescence" &&
        payload.evidence.status === "quiescent"
      )
        this.quiescent = true;
      if (
        payload.kind === "user_input_requested" ||
        payload.kind === "approval_requested"
      ) {
        this.pendingRequests.set(JSON.stringify(payload.replyTo), payload);
        this.notifyRequest(payload);
      }
    }
    return ack;
  }

  private notifyRequest(request: Approval | UserInput): void {
    const origin = JSON.stringify(request.replyTo);
    // Recovery validates immutable request receipts in the canonical store;
    // this set only prevents repeating their post-commit notification.
    if (this.requestOrigins.has(origin)) return;
    // A commit-time duplicate restores all canonical facts, including requests
    // already handed to this coordinator. Do not restart an approval waiter or
    // register the same user-input request twice. Retain consumed origins too.
    this.requestOrigins.add(origin);
    try {
      if (request.kind === "approval_requested")
        this.options.onApproval(request);
      else this.options.onUserInput(request);
    } catch (error) {
      this.fenced = true;
      throw error;
    }
  }

  private validateAck(
    input: HarnessCommitAck,
    observation: HarnessObservation,
  ): HarnessCommitAck {
    const ack = HarnessCommitAckSchema.parse(input);
    if (
      !sameHarnessSession(ack.session, observation.session) ||
      ack.committedSequence !== observation.sequence
    )
      this.reject("Observation ACK identity mismatch");
    return ack;
  }

  private reject(message: string): never {
    throw new RuntimeKernelError("worker_failed", message);
  }
}
