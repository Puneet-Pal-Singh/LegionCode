import { JsonRecordSchema, toPublicProtocolError } from "@repo/platform-protocol";
import type {
  HarnessSelection,
  ItemId,
  Run,
  Turn,
} from "@repo/platform-protocol";
import {
  HarnessQuiescenceSchema,
  HarnessSessionSchema,
  type HarnessQuiescence,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import { ApprovalCoordinator } from "../ApprovalCoordinator.js";
import { RuntimeKernelError } from "../errors.js";
import { RuntimeLifecycleCoordinator } from "../RuntimeLifecycleCoordinator.js";
import type {
  DelegatedHarnessPort,
  HarnessObservationCommitPort,
  HarnessObservationRecovery,
} from "./DelegatedHarnessPort.js";
import {
  HarnessObservationIngestor,
  sameHarnessSession,
} from "./HarnessObservationIngestor.js";

type Quiescent = Extract<HarnessQuiescence, { status: "quiescent" }>;
export interface DelegatedExecutionDependencies {
  readonly harness: DelegatedHarnessPort;
  readonly observations: HarnessObservationCommitPort;
  /** Capabilities from the selected/pinned driver's successful probe. Absence
   * exposes no optional steering capability. */
  readonly capabilities?: import("@repo/platform-protocol").HarnessCapabilities;
  /** Existing admission/lease authority verifies the frozen selection and held
   * workspace lease. Recheck auth generation/revocation before external commands. */
  readonly assertActive: (input: {
    readonly selection: HarnessSelection;
    readonly leaseId: HarnessStartCommand["leaseId"];
    readonly filesystemRoot: string;
  }) => Promise<void>;
}

/** Delegated execution composes canonical owners, never native ProviderPort/tools. */
export class DelegatedTurnCoordinator {
  private session: import("@repo/worker-protocol").HarnessSession | null = null;
  private ingestor: HarnessObservationIngestor | null = null;
  private steeringFailure: unknown;
  private readonly steeringOperations = new Set<Promise<void>>();
  private stopRequested = false;
  private readonly mutationController = new AbortController();
  private interruptSent = false;
  private integrityRecovery: Promise<HarnessObservationRecovery> | null = null;
  private readonly replies = new Set<string>();
  private readonly approvalJobs = new Set<Promise<void>>();
  private approvalFailure: unknown;
  private readonly userInputs = new Map<
    string,
    Extract<
      import("@repo/worker-protocol").HarnessObservationPayload,
      { kind: "user_input_requested" }
    >
  >();
  private quiescent: Quiescent | null = null;

  constructor(
    private readonly options: {
      readonly dependencies: DelegatedExecutionDependencies;
      readonly command: HarnessStartCommand;
      readonly run: Run;
      readonly turn: Turn;
      readonly lifecycle: RuntimeLifecycleCoordinator;
      readonly approvals: ApprovalCoordinator;
      readonly signal: AbortSignal;
    },
  ) {
    if (options.command.mode === "recover_same_attempt") {
      if (!options.command.resumeSession)
        throw new RuntimeKernelError(
          "invalid_turn_identity",
          "Recovery has no persisted session identity",
        );
      this.session = HarnessSessionSchema.parse(options.command.resumeSession);
    }
  }

  get quiescenceEvidence(): Quiescent | null {
    return this.quiescent;
  }

  async execute(): Promise<{
    output: string;
    finalItemId: ItemId;
    toolCallCount: number;
  }> {
    const { dependencies, command, signal } = this.options;
    this.assertNotStopped();
    await dependencies.assertActive(command);
    this.assertNotStopped();
    if (command.mode === "start")
      this.session = HarnessSessionSchema.parse(
        await dependencies.harness.open({ command, signal }),
      );
    if (!this.session)
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        "Recovery session is unavailable",
      );
    if (
      this.session.runAttemptId !== command.selection.runAttemptId ||
      this.session.instanceId !== command.selection.instanceId
    ) {
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        "Opened harness has a different attempt/instance",
      );
    }
    const ingestor = new HarnessObservationIngestor({
      selection: command.selection,
      session: this.session,
      lifecycle: this.options.lifecycle,
      persistence: dependencies.observations,
      onUserInput: (request) => {
        if (this.userInputs.has(request.requestId))
          throw new RuntimeKernelError(
            "approval_resolution_conflict",
            "User input request identity was reused",
          );
        this.userInputs.set(request.requestId, request);
      },
      onApproval: (approval) => {
        const job = this.replyToApproval(approval).catch((error: unknown) => {
          this.approvalFailure = error;
        });
        this.approvalJobs.add(job);
        void job.finally(() => this.approvalJobs.delete(job));
      },
    });
    this.ingestor = ingestor;
    await ingestor.ready();
    if (signal.aborted || this.stopRequested) {
      await this.stop();
      throw new RuntimeKernelError(
        "turn_cancelled",
        "Turn stopped before external prompt delivery",
      );
    }
    await dependencies.assertActive(command);
    this.assertNotStopped();
    if (ingestor.hasPriorIngress || command.resumeSession !== null) {
      await dependencies.harness.observeExisting({
        session: this.session,
        signal,
        observe: (observation) => ingestor.observe(observation),
      });
    } else {
      await dependencies.harness.execute({
        command,
        session: this.session,
        signal,
        observe: (observation) => ingestor.observe(observation),
      });
    }
    await Promise.all(this.approvalJobs);
    await Promise.all(this.steeringOperations);
    if (this.steeringFailure) throw this.steeringFailure;
    if (this.approvalFailure) throw this.approvalFailure;
    this.assertNotStopped();
    const terminal = ingestor.terminalObservation;
    if (!terminal)
      throw new RuntimeKernelError(
        "worker_failed",
        "Harness stream closed without terminal evidence",
      );
    if (terminal.status !== "completed") {
      const failure = toPublicProtocolError(terminal.error, {
        code: terminal.status === "interrupted" ? "command_cancelled" : "command_failed",
        retryable: false,
      });
      throw new RuntimeKernelError(
        terminal.status === "interrupted" ? "turn_cancelled" : "worker_failed",
        failure.message,
        failure,
      );
    }
    await this.requireQuiescence();
    this.assertNotStopped();
    if (
      !(await this.options.lifecycle.reserveCompletion(() =>
        this.options.lifecycle.hasPendingThreadInputs(),
      ))
    ) {
      throw new RuntimeKernelError(
        "worker_failed",
        "Steering acceptance has no provider application evidence; recovery is required",
      );
    }
    return {
      output: terminal.output,
      finalItemId: terminal.itemId,
      toolCallCount: ingestor.toolCallCount,
    };
  }

  async acceptThreadInput(input: {
    readonly accepted: Omit<
      import("../types.js").AcceptedThreadInput,
      "acceptedSequence"
    >;
    readonly clientInputId: string;
    readonly transcriptMessageId: string;
  }): Promise<number> {
    const delivery = this.deliverSteer(input);
    const tracked = delivery.then(
      () => undefined,
      () => undefined,
    );
    this.steeringOperations.add(tracked);
    void tracked.finally(() => this.steeringOperations.delete(tracked));
    return delivery;
  }

  private async deliverSteer(input: {
    readonly accepted: Omit<
      import("../types.js").AcceptedThreadInput,
      "acceptedSequence"
    >;
    readonly clientInputId: string;
    readonly transcriptMessageId: string;
  }): Promise<number> {
    this.assertNotStopped();
    if (this.options.dependencies.capabilities?.steer !== true)
      throw new RuntimeKernelError(
        "tool_policy_denied",
        "Selected harness does not advertise steering",
      );
    const session = this.session,
      ingestor = this.ingestor;
    if (!session || !ingestor)
      throw new RuntimeKernelError(
        "turn_not_active",
        "Harness has no live steering target",
      );
    await ingestor.ready();
    const target = ingestor.steeringTarget;
    if (!target)
      throw new RuntimeKernelError(
        "turn_not_active",
        "External turn is not accepting steering",
      );
    const message = input.accepted.message;
    if (
      message.role !== "user" ||
      typeof message.content !== "string" ||
      !message.content.trim()
    )
      throw new RuntimeKernelError(
        "tool_policy_denied",
        "This harness steering path accepts text user input only",
      );
    const text = message.content;
    const accepted = {
      inputId: input.accepted.inputId,
      clientInputId: input.clientInputId,
      transcriptMessageId: input.transcriptMessageId,
    };
    await this.options.dependencies.assertActive(this.options.command);
    this.assertNotStopped();
    let newlyAccepted = false;
    const acceptedSequence = await this.options.lifecycle.acceptThreadInput(
      accepted,
      () => {
        newlyAccepted = true;
      },
      () =>
        !this.stopRequested &&
        !this.options.signal.aborted &&
        ingestor.steeringTarget === target,
      true,
    );
    // A duplicate accepted intent never resends a command whose delivery may be ambiguous.
    if (!newlyAccepted) return acceptedSequence;
    try {
      await this.options.dependencies.assertActive(this.options.command);
      this.assertNotStopped();
      if (ingestor.steeringTarget !== target)
        throw new RuntimeKernelError(
          "turn_not_active",
          "External turn finished before steering delivery",
        );
      const receipt = await this.options.dependencies.harness.control({
        kind: "steer",
        commandId: `${this.options.command.commandId}:steer:${acceptedSequence}`,
        session,
        expectedExternalTurnId: target,
        accepted: { ...accepted, acceptedSequence },
        text,
      });
      if (!receipt.accepted)
        throw new RuntimeKernelError(
          "worker_failed",
          "Harness rejected steering; accepted intent requires recovery",
        );
    } catch (error) {
      this.steeringFailure = error;
      throw error;
    }
    return acceptedSequence;
  }

  /** Safe before open resolves. The latch prevents any subsequent prompt delivery. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.mutationController.abort();
    if (!this.session || this.interruptSent) return;
    this.interruptSent = true;
    // Stop remains available after auth revocation; it cannot start new work.
    await this.options.dependencies.harness.control({
      kind: "interrupt",
      commandId: `${this.options.command.commandId}:interrupt`,
      session: this.session,
    });
  }

  async requireQuiescence(): Promise<Quiescent> {
    if (!this.session)
      throw new RuntimeKernelError(
        "worker_failed",
        "Harness process identity is unknown; retain lease for recovery",
      );
    this.quiescent = null;
    const evidence = HarnessQuiescenceSchema.parse(
      await this.options.dependencies.harness.awaitQuiescence({
        session: this.session,
        timeoutMs: 2_000,
      }),
    );
    if (sameHarnessSession(evidence.session, this.session) &&
      ((evidence.status === "unknown" && evidence.reason === "observation_integrity_lost") ||
       (evidence.status === "quiescent" && evidence.observationIntegrity === "lost"))) {
      // Cleanup outlives execution cancellation. Stop must not prevent the
      // canonical owner from recording integrity loss and retaining the lease.
      await this.resolveObservationIntegrity({
        command: this.options.command,
        session: this.session,
        signal: AbortSignal.timeout(2_000),
      });
    }
    if (
      !sameHarnessSession(evidence.session, this.session) ||
      evidence.status !== "quiescent" || evidence.observationIntegrity !== "complete"
    ) {
      throw new RuntimeKernelError(
        "worker_failed",
        "Harness quiescence is unproven; retain lease for recovery",
      );
    }
    this.quiescent = evidence;
    return evidence;
  }

  async resolveObservationIntegrity(input: {
    readonly command: HarnessStartCommand;
    readonly session: import("@repo/worker-protocol").HarnessSession;
    readonly signal: AbortSignal;
  }): Promise<HarnessObservationRecovery> {
    if (
      !this.session || !sameHarnessSession(this.session, input.session) ||
      input.command.leaseId !== this.options.command.leaseId ||
      input.command.filesystemRoot !== this.options.command.filesystemRoot ||
      JSON.stringify(input.command.selection) !== JSON.stringify(this.options.command.selection)
    )
      throw new RuntimeKernelError("invalid_turn_identity", "Integrity recovery has a stale binding");
    this.stopRequested = true;
    this.mutationController.abort();
    if (this.integrityRecovery) return this.integrityRecovery;
    const cleanup = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An unresponsive persistence callback may ignore cancellation. Bound the
    // caller's wait too; retain this result so timeout never starts a second job.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cleanup.abort();
        reject(new RuntimeKernelError(
          "worker_failed",
          "Integrity cleanup timed out; retain lease for recovery",
        ));
      }, 2_000);
    });
    const work = Promise.resolve().then(() => this.options.lifecycle.resolveObservationIntegrity({
      ...input,
      signal: AbortSignal.any([input.signal, cleanup.signal]),
      persistence: this.options.dependencies.observations,
    }));
    this.integrityRecovery = Promise.race([work, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return this.integrityRecovery;
  }

  async respondUserInput(
    requestId: string,
    response: import("@repo/platform-protocol").JsonRecord,
    respondedBy: import("@repo/platform-protocol").UserId | null,
  ): Promise<void> {
    this.assertNotStopped();
    response = JsonRecordSchema.parse(response);
    if (
      respondedBy !== null &&
      respondedBy !== this.options.command.selection.userId
    )
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        "User input responder does not own the admitted selection",
      );
    const request = this.userInputs.get(requestId);
    if (!request)
      throw new RuntimeKernelError(
        "turn_not_active",
        "User input request is no longer pending",
      );
    const key = JSON.stringify(request.replyTo);
    if (this.replies.has(key))
      throw new RuntimeKernelError(
        "approval_resolution_conflict",
        "User input reply was already consumed",
      );
    // Reserve before the first await; concurrent replies cannot both append or send.
    this.replies.add(key);
    await this.options.dependencies.assertActive(this.options.command);
    this.assertNotStopped();
    if (
      (await this.options.dependencies.observations.claimReply(
        request.replyTo,
      )) !== "claimed"
    )
      throw new RuntimeKernelError(
        "approval_resolution_conflict",
        "User input reply was already durably consumed",
      );
    this.assertNotStopped();
    await this.options.lifecycle.respondUserInput(
      requestId,
      response,
      respondedBy,
    );
    this.userInputs.delete(requestId);
    this.assertNotStopped();
    await this.options.dependencies.harness.control({
      kind: "user_input_reply",
      commandId: `user_input:${requestId}`,
      reply: { replyTo: request.replyTo, response },
    });
  }

  private assertNotStopped(): void {
    if (this.stopRequested || this.options.signal.aborted)
      throw new RuntimeKernelError("turn_cancelled", "Turn stopped by user");
  }

  private async replyToApproval(
    approval: Extract<
      import("@repo/worker-protocol").HarnessObservationPayload,
      { kind: "approval_requested" }
    >,
  ): Promise<void> {
    const { command, run, turn, signal, dependencies } = this.options;
    if (signal.aborted || this.stopRequested) return;
    const key = JSON.stringify(approval.replyTo);
    if (this.replies.has(key))
      throw new RuntimeKernelError(
        "approval_resolution_conflict",
        "Harness request was already consumed",
      );
    this.replies.add(key);
    let decision: import("@repo/platform-protocol").ApprovalDecision;
    let grantScope:
      | import("@repo/platform-protocol").ApprovalGrantScope
      | undefined;
    try {
      const resolution = await this.options.approvals.requestAndWait(
        run,
        command.selection.runAttemptId,
        turn,
        approval.parentItemId,
        approval.request,
        AbortSignal.any([signal, this.mutationController.signal]),
        true,
      );
      decision = resolution.decision;
      grantScope = resolution.grantScope;
    } catch (error) {
      if (!(error instanceof RuntimeKernelError)) throw error;
      if (
        error.code === "approval_denied" ||
        error.code === "approval_timed_out"
      )
        decision = "denied";
      else if (error.code === "turn_cancelled") decision = "cancelled";
      else throw error;
    }
    // Never replay an ambiguous reply, including transport failure after send.
    if (signal.aborted || this.stopRequested) return;
    await dependencies.assertActive(command);
    if (signal.aborted || this.stopRequested) return;
    if (
      (await dependencies.observations.claimReply(approval.replyTo)) !==
      "claimed"
    )
      throw new RuntimeKernelError(
        "approval_resolution_conflict",
        "Harness reply was already durably consumed",
      );
    this.assertNotStopped();
    await dependencies.harness.control({
      kind: "reply",
      commandId: `approval:${approval.request.approvalId}`,
      reply: {
        replyTo: approval.replyTo,
        decision,
        ...(grantScope ? { grantScope } : {}),
      },
    });
  }
}
