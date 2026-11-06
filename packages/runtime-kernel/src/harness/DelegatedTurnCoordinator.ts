import { JsonRecordSchema } from "@repo/platform-protocol";
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
} from "./DelegatedHarnessPort.js";
import {
  HarnessObservationIngestor,
  sameHarnessSession,
} from "./HarnessObservationIngestor.js";

type Quiescent = Extract<HarnessQuiescence, { status: "quiescent" }>;
export interface DelegatedExecutionDependencies {
  readonly harness: DelegatedHarnessPort;
  readonly observations: HarnessObservationCommitPort;
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
  private stopRequested = false;
  private interruptSent = false;
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
  ) {}

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
    this.session = HarnessSessionSchema.parse(
      await dependencies.harness.open({ command, signal }),
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
    if (this.approvalFailure) throw this.approvalFailure;
    this.assertNotStopped();
    const terminal = ingestor.terminalObservation;
    if (!terminal)
      throw new RuntimeKernelError(
        "worker_failed",
        "Harness stream closed without terminal evidence",
      );
    if (terminal.status !== "completed") {
      throw new RuntimeKernelError(
        terminal.status === "interrupted" ? "turn_cancelled" : "worker_failed",
        terminal.error?.message ?? "Harness did not complete the turn",
      );
    }
    await this.requireQuiescence();
    this.assertNotStopped();
    return {
      output: terminal.output,
      finalItemId: terminal.itemId,
      toolCallCount: ingestor.toolCallCount,
    };
  }

  /** Safe before open resolves. The latch prevents any subsequent prompt delivery. */
  async stop(): Promise<void> {
    this.stopRequested = true;
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
    if (this.quiescent) return this.quiescent;
    if (!this.session)
      throw new RuntimeKernelError(
        "worker_failed",
        "Harness process identity is unknown; retain lease for recovery",
      );
    const evidence = HarnessQuiescenceSchema.parse(
      await this.options.dependencies.harness.awaitQuiescence({
        session: this.session,
        timeoutMs: 2_000,
      }),
    );
    if (
      !sameHarnessSession(evidence.session, this.session) ||
      evidence.status !== "quiescent"
    ) {
      throw new RuntimeKernelError(
        "worker_failed",
        "Harness quiescence is unproven; retain lease for recovery",
      );
    }
    this.quiescent = evidence;
    return evidence;
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
    await this.options.lifecycle.respondUserInput(
      requestId,
      response,
      respondedBy,
    );
    this.userInputs.delete(requestId);
    this.assertNotStopped();
    await this.options.dependencies.harness.control({
      kind: "user_input_reply",
      commandId: `${this.options.command.commandId}:reply:${this.replies.size}`,
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
        signal,
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
    await dependencies.harness.control({
      kind: "reply",
      commandId: `${command.commandId}:reply:${this.replies.size}`,
      reply: {
        replyTo: approval.replyTo,
        decision,
        ...(grantScope ? { grantScope } : {}),
      },
    });
  }
}
