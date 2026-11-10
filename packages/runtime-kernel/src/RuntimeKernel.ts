import { bootstrapDelegatedRecovery } from "./harness/DelegatedRecoveryBootstrap.js";
import { HarnessSelectionSchema } from "@repo/platform-protocol";
import { HarnessStartCommandSchema } from "@repo/worker-protocol";
import { DelegatedTurnCoordinator, type DelegatedExecutionDependencies } from "./harness/DelegatedTurnCoordinator.js";
import { omitsReadOnlyArtifacts } from "./ReadOnlyArtifactPolicy.js";
import {
  ItemIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
  LifecycleEventSchema,
  LifecycleTransitionError,
  type LifecycleEvent,
  type Run,
  type Turn,
  type ResumeWorkspaceUnavailableReason,
} from "@repo/platform-protocol";
import type { WorkspaceManifestRepository } from "@repo/workspace-core";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
import { CanonicalApprovalDeadlinePort } from "./CanonicalApprovalDeadlinePort.js";
import {
  RuntimeKernelError,
  RuntimeLifecycleSettlementError,
  toProtocolError,
} from "./errors.js";
import type {
  ApprovalWaitPort,
  ContextAssemblyPort,
  ContextCompactionMode,
  ContextCompactionPort,
  ProviderPort,
  RuntimeLifecycleEventStore,
  RuntimeGitSnapshotPort,
  RuntimeKernelClock,
  RuntimeHookOrchestrationPort,
  RuntimeTurnArtifactPort,
  ToolAuthorizationPort,
  WorkerProtocolPort,
} from "./ports.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import type { AcceptedThreadInput, StartTurnInput, StartTurnResult, ToolResult } from "./types.js";
import { ToolExecutionCoordinator } from "./ToolExecutionCoordinator.js";
import { reconcileProviderContextBudget } from "./ProviderContextBudget.js";
import {
  TurnArtifactSettlementCoordinator,
  type TurnArtifactSettlementResult,
} from "./TurnArtifactSettlementCoordinator.js";
import { WorkspaceCoordinator } from "./WorkspaceCoordinator.js";

const DEFAULT_MAX_TOOL_CALLS = 32;
const systemClock: RuntimeKernelClock = { now: () => new Date().toISOString() };

export interface RuntimeKernelDependencies {
  readonly lifecycleEvents: RuntimeLifecycleEventStore;
  readonly gitSnapshots?: RuntimeGitSnapshotPort;
  readonly turnArtifacts?: RuntimeTurnArtifactPort;
  /** Explicit opt-in for a backend that cannot mutate the workspace. */
  readonly artifactCapture?: "required" | "omitted_read_only";
  readonly workspaceManifests?: Pick<WorkspaceManifestRepository, "getLatestByRunId">;
  readonly contextAssembly?: ContextAssemblyPort;
  readonly contextCompaction?: ContextCompactionPort;
  readonly provider?: ProviderPort;
  readonly worker?: WorkerProtocolPort;
  readonly toolAuthorization?: ToolAuthorizationPort;
  readonly approvals?: ApprovalWaitPort;
  readonly hooks?: RuntimeHookOrchestrationPort;
  readonly producerId: string;
  readonly maxToolCalls?: number;
  readonly clock?: RuntimeKernelClock;
  readonly signal?: AbortSignal;
  readonly delegated?: DelegatedExecutionDependencies;
}

interface PreparedTurn {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: StartTurnInput["runAttemptId"];
  readonly workspace: WorkspaceManifest | null;
  readonly lifecycle: RuntimeLifecycleCoordinator;
  readonly artifacts: TurnArtifactSettlementCoordinator | null;
  readonly tools: ToolExecutionCoordinator | null;
  readonly delegated: DelegatedTurnCoordinator | null;
  readonly executionSignal: AbortSignal;
  readonly hookTriggerEvents: {
    readonly sessionStart: LifecycleEvent;
    readonly userPromptSubmit: LifecycleEvent;
  } | null;
}

export class RuntimeKernel {
  private readonly workspaces: WorkspaceCoordinator | null;
  private readonly maxToolCalls: number;
  private readonly clock: RuntimeKernelClock;
  private readonly lifecycles = new Map<string, RuntimeLifecycleCoordinator>();
  private readonly approvalCoordinators = new Map<
    string,
    ApprovalCoordinator
  >();
  private readonly artifactSettlements = new Map<
    string,
    TurnArtifactSettlementCoordinator
  >();
  private readonly artifactSettlementEmissions = new Map<
    string,
    Promise<TurnArtifactSettlementResult>
  >();
  private readonly unsafeWorkspaces = new Set<string>();
  private readonly pendingInterrupts = new Map<string, string>();
  private readonly executions = new Map<string, Promise<StartTurnResult>>();
  private readonly preparedTurns = new Map<string, PreparedTurn>();
  private readonly activeContexts = new Map<
    string,
    Awaited<ReturnType<ContextAssemblyPort["assemble"]>>
  >();
  private readonly compactedContexts = new Set<string>();
  private readonly compactions = new Map<string, Promise<void>>();
  private readonly automaticCompactions = new Set<string>();
  private readonly executionControllers = new Map<string, AbortController>();

  constructor(private readonly dependencies: RuntimeKernelDependencies) {
    this.workspaces = dependencies.workspaceManifests ? new WorkspaceCoordinator(dependencies.workspaceManifests) : null;
    this.maxToolCalls = dependencies.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.clock = dependencies.clock ?? systemClock;
    if (dependencies.signal) {
      if (dependencies.signal.aborted) {
        this.abortAllExecutions(dependencies.signal.reason);
      } else {
        dependencies.signal.addEventListener(
          "abort",
          () => this.abortAllExecutions(dependencies.signal?.reason),
          { once: true },
        );
      }
    }
  }

  async acceptThreadInput(input: {
    readonly turnId: Turn["id"];
    readonly accepted: Omit<AcceptedThreadInput, "acceptedSequence">;
    readonly clientInputId: string;
    readonly transcriptMessageId: string;
  }): Promise<number> {
    const delegated = this.preparedTurns.get(input.turnId)?.delegated;
    if (delegated) return delegated.acceptThreadInput(input);
    const lifecycle = this.lifecycles.get(input.turnId);
    if (!lifecycle || !this.dependencies.provider?.enqueueThreadInput) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${input.turnId} has no active model input owner`,
      );
    }
    return await lifecycle.acceptThreadInput(
      {
        inputId: input.accepted.inputId,
        clientInputId: input.clientInputId,
        transcriptMessageId: input.transcriptMessageId,
      },
      (acceptedSequence) => {
        this.dependencies.provider?.enqueueThreadInput?.({
          ...input.accepted,
          acceptedSequence,
        });
      },
    );
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    // Rejection must not enter the preparation-failure lifecycle appender.
    await this.assertLifecycleStartAllowed(input);
    let prepared: PreparedTurn;
    try {
      prepared = await this.prepareTurn(input);
    } catch (error) {
      // A durable local admission must settle even if its workspace was revoked before start.
      if (
        (this.dependencies.artifactCapture === "omitted_read_only" ||
          this.dependencies.worker?.executionCapability === "guarded_mutation") &&
        input.execution?.kind !== "delegated" &&
        input.run.harnessSelection?.selection == null &&
        !this.lifecycles.has(input.turn.id)
      ) {
        const run = RunSchema.parse(input.run);
        const turn = TurnSchema.parse(input.turn);
        const attempt = RunAttemptIdSchema.parse(input.runAttemptId);
        this.assertTurnIdentity(run, turn);
        const lifecycle = this.createLifecycle(run, turn, attempt, input);
        await lifecycle.start();
        if (this.dependencies.signal?.aborted) {
          await lifecycle.interrupt(cancellationReason(this.dependencies.signal) ?? "Turn interrupted during preparation");
        } else {
          await this.recoverFailedTurn(lifecycle, error);
        }
        this.pendingInterrupts.delete(turn.id);
      }
      throw error;
    }
    this.preparedTurns.set(prepared.turn.id, prepared);
    const pendingReason = this.pendingInterrupts.get(prepared.turn.id);
    if (pendingReason) {
      this.pendingInterrupts.delete(prepared.turn.id);
      let quiescent = true;
      if (prepared.delegated && input.execution?.kind === "delegated" && input.execution.recovery === "same_attempt" && !prepared.lifecycle.isTerminalDecided) {
        try { await prepared.delegated.stop(); await prepared.delegated.requireQuiescence(); }
        catch { quiescent = false; }
      }
      if (!prepared.lifecycle.isTerminalDecided) await this.interruptPreparedTurn(prepared, pendingReason, quiescent);
      this.executionControllers.delete(prepared.turn.id);
      this.preparedTurns.delete(prepared.turn.id);
      return {
        status: "completed",
        output: "",
        toolCallCount: 0,
        workspace: prepared.workspace,
      };
    }
    const execution = this.executePreparedTurn(prepared);
    this.executions.set(prepared.turn.id, execution);
    try {
      return await execution;
    } finally {
      this.executions.delete(prepared.turn.id);
      this.executionControllers.delete(prepared.turn.id);
      this.preparedTurns.delete(prepared.turn.id);
    }
  }

  private async assertLifecycleStartAllowed(input: StartTurnInput): Promise<void> {
    const run = RunSchema.parse(input.run);
    const turn = TurnSchema.parse(input.turn);
    const attempt = RunAttemptIdSchema.parse(input.runAttemptId);
    this.assertTurnIdentity(run, turn);
    this.assertTurnAvailable(turn);
    // This read prevents blind restart; durable admission/checkout claims still
    // exclusively arbitrate concurrent writers. A supplied cursor is no claim.
    const replay = await this.dependencies.lifecycleEvents.replay({
      turnId: turn.id, afterSequence: null, limit: 1,
    });
    this.assertTurnAvailable(turn);
    if (!Array.isArray(replay.events) || replay.events.length > 1)
      throw new RuntimeKernelError("invalid_turn_identity", "Lifecycle preflight exceeded its replay limit");
    const recovery = input.execution?.kind === "delegated" && input.execution.recovery === "same_attempt";
    if (replay.events.length === 0) {
      if (replay.nextSequence !== null || turn.lastEventSequence !== 0 || recovery)
        throw new RuntimeKernelError("invalid_turn_identity", "Empty canonical lifecycle conflicts with the requested cursor or recovery");
      return;
    }
    const parsed = LifecycleEventSchema.safeParse(replay.events[0]);
    if (!parsed.success)
      throw new RuntimeKernelError("invalid_turn_identity", "Canonical lifecycle preflight returned a malformed event");
    const first = parsed.data;
    if (
      first.turnId !== turn.id || first.threadId !== run.threadId ||
      first.runAttemptId !== attempt || first.sequence !== 1 ||
      (replay.nextSequence !== null && replay.nextSequence !== first.sequence)
    )
      throw new RuntimeKernelError("invalid_turn_identity", "Canonical lifecycle preflight has a different identity or sequence");
    if (!recovery)
      throw new RuntimeKernelError("turn_already_owned", "Canonical lifecycle history requires explicit supported recovery");
    // Only the existing delegated strategy may continue to its full persisted
    // session/generation, frozen binding and committed start-snapshot checks.
  }

  private async prepareTurn(input: StartTurnInput): Promise<PreparedTurn> {
    const run = RunSchema.parse(input.run);
    const turn = TurnSchema.parse(input.turn);
    const runAttemptId = RunAttemptIdSchema.parse(input.runAttemptId);
    this.assertTurnIdentity(run, turn);
    this.assertTurnAvailable(turn);
    const recoveryRequested = input.execution?.kind === "delegated" && input.execution.recovery === "same_attempt";
    if (turn.lastEventSequence > 0 && !recoveryRequested) throw new RuntimeKernelError("turn_already_owned", "Existing attempt history requires explicit same-attempt recovery");
    const workspace = run.executionCapability === "conversation"
      ? null : await this.requireWorkspace(run);
    const delegatedInput = input.execution?.kind === "delegated" ? input.execution : null;
    if (!delegatedInput && run.harnessSelection?.selection != null) throw new RuntimeKernelError("invalid_turn_identity", "Admitted delegated selection requires its resolved delegated execution strategy");
    if (delegatedInput) {
      const selection = HarnessSelectionSchema.parse(delegatedInput.selection);
      if (!workspace || !this.dependencies.delegated || selection.userId !== run.userId ||
        selection.workspaceId !== run.workspaceId || selection.threadId !== run.threadId ||
        selection.runId !== run.id || selection.turnId !== turn.id || selection.runAttemptId !== runAttemptId ||
        selection.modelId !== run.modelId || selection.policyId !== run.permissionProfileId) {
        throw new RuntimeKernelError("invalid_turn_identity", "Delegated selection does not match admitted execution");
      }
      const admittedSelection = run.harnessSelection;
      if (admittedSelection && (admittedSelection.environmentId !== selection.environmentId ||
        admittedSelection.selectionRevision !== selection.selectionRevision || admittedSelection.selection === null ||
        admittedSelection.selection.harness !== selection.harness || admittedSelection.selection.instanceId !== selection.instanceId ||
        admittedSelection.selection.connectionId !== selection.connectionId || admittedSelection.selection.modelId !== selection.modelId)) {
        throw new RuntimeKernelError("invalid_turn_identity", "Resolved harness binding differs from frozen admitted selection");
      }
      await this.dependencies.delegated.assertActive({ selection, leaseId: delegatedInput.leaseId,
        filesystemRoot: workspace.filesystemRoot });
    }
    const omitArtifacts = omitsReadOnlyArtifacts(this.dependencies, run, input.execution);
    const artifactSettlement = workspace && !omitArtifacts
      ? this.createArtifactSettlement(run, turn, workspace) : null;
    const recoverySession = recoveryRequested ? delegatedInput?.resumeSession : null;
    if (recoveryRequested && (!recoverySession || recoverySession.runAttemptId !== runAttemptId || recoverySession.instanceId !== delegatedInput?.selection.instanceId)) {
      throw new RuntimeKernelError("invalid_turn_identity", "Same-attempt recovery requires its exact persisted session");
    }
    const restored = recoverySession && this.dependencies.delegated
      ? await bootstrapDelegatedRecovery({ persistence: this.dependencies.delegated.observations,
          session: recoverySession, turnId: turn.id, minimumSequence: turn.lastEventSequence }) : null;
    const lifecycle = this.createLifecycle(run, turn, runAttemptId, input);
    let startArtifacts: Awaited<ReturnType<TurnArtifactSettlementCoordinator["begin"]>> | undefined;
    try {
      if (restored) {
        await lifecycle.restoreHarnessHistory(restored.recovery.lifecycleEvents);
        artifactSettlement?.restoreCommittedStart(restored.start);
        startArtifacts = restored.start;
      } else startArtifacts = await artifactSettlement?.begin();
    } catch (error) {
      this.lifecycles.delete(turn.id);
      throw error;
    }
    if (artifactSettlement) this.artifactSettlements.set(turn.id, artifactSettlement);
    const approvals = new ApprovalCoordinator(
      this.dependencies.approvals ?? new CanonicalApprovalDeadlinePort(),
      lifecycle,
    );
    this.approvalCoordinators.set(turn.id, approvals);
    const native = delegatedInput ? null : this.requireNativePorts();
    const tools = native ? new ToolExecutionCoordinator(native.worker, native.toolAuthorization, approvals, lifecycle) : null;
    const executionController = new AbortController();
    if (this.dependencies.signal?.aborted) {
      executionController.abort(this.dependencies.signal.reason);
    }
    this.executionControllers.set(turn.id, executionController);
    const lifecycleStart = restored ? null : await lifecycle.start();
    if (!restored && startArtifacts) await lifecycle.captureWorkspaceSnapshot(startArtifacts);
    const delegated = delegatedInput && this.dependencies.delegated && workspace && startArtifacts
      ? new DelegatedTurnCoordinator({
          dependencies: this.dependencies.delegated,
          command: HarnessStartCommandSchema.parse({
            mode: restored ? "recover_same_attempt" : "start",
            commandId: `${runAttemptId}:start`, selection: delegatedInput.selection,
            leaseId: delegatedInput.leaseId, startSnapshot: startArtifacts.snapshot,
            filesystemRoot: workspace.filesystemRoot, prompt: delegatedInput.prompt,
            resumeSession: delegatedInput.resumeSession,
          }),
          run, turn, lifecycle, approvals, signal: executionController.signal,
        }) : null;
    return {
      run,
      turn,
      runAttemptId,
      workspace,
      lifecycle,
      delegated,
      artifacts: artifactSettlement,
      tools,
      executionSignal: executionController.signal,
      hookTriggerEvents: lifecycleStart ? {
        sessionStart: lifecycleStart.turnStarted,
        userPromptSubmit: lifecycleStart.runAttemptStarted,
      } : null,
    };
  }

  private async executePreparedTurn(
    prepared: PreparedTurn,
  ): Promise<StartTurnResult> {
    const { turn, workspace, lifecycle, artifacts } = prepared;
    try {
      if (lifecycle.isTerminal) {
        return {
          status: "completed",
          output: "",
          toolCallCount: 0,
          workspace,
        };
      }
      prepared.executionSignal.throwIfAborted();
      await this.runHooks(prepared);
      const result = prepared.delegated
        ? { status: "completed" as const, ...await prepared.delegated.execute() }
        : await this.executeNativePreparedTurn(prepared);
      if (prepared.executionSignal.aborted || lifecycle.isTerminal) {
        throw new LifecycleTransitionError(
          "turn",
          "interrupted",
          "completed",
          "turn was interrupted before successful settlement",
        );
      }
      if (this.dependencies.worker?.executionCapability === "guarded_mutation") {
        await this.awaitGuardedQuiescence(turn.id);
        prepared.executionSignal.throwIfAborted();
      }
      await this.settleArtifacts(turn.id, lifecycle, artifacts);
      // Snapshot capture awaits filesystem/Git work. Stop may have been accepted
      // during that await; revalidate before entering terminal arbitration.
      if (prepared.executionSignal.aborted) throw new RuntimeKernelError("turn_cancelled", "Turn stopped during artifact capture");
      if (prepared.delegated) await prepared.delegated.requireQuiescence();
      await lifecycle.complete(result.output, result.finalItemId, () => !prepared.executionSignal.aborted);
      return {
        status: result.status,
        output: result.output,
        toolCallCount: result.toolCallCount,
        workspace,
      };
    } catch (error) {
      if (!lifecycle.isTerminalDecided && !lifecycle.requiresHarnessRecovery) {
        if (!isArtifactSettlementError(error)) {
          const interrupted =
            isTurnCancelled(error) || prepared.executionSignal.aborted;
          const requiresQuiescence = interrupted || prepared.delegated !== null ||
            this.dependencies.worker?.executionCapability === "guarded_mutation";
          let resumeQuiescent = false;
          if (prepared.delegated) {
            try {
              await prepared.delegated.stop();
              await prepared.delegated.requireQuiescence();
              resumeQuiescent = true;
            } catch { /* Unknown quiescence retains checkout ownership for recovery. */ }
          } else {
            resumeQuiescent = requiresQuiescence &&
              (await this.dependencies.worker?.awaitQuiescence?.({ turnId: turn.id, timeoutMs: 500 })) === true;
            if (this.dependencies.worker?.executionCapability === "guarded_mutation" && !resumeQuiescent) {
              await this.awaitGuardedQuiescence(turn.id);
              resumeQuiescent = true;
            }
          }
          await this.settleArtifacts(
            turn.id,
            lifecycle,
            artifacts,
            true,
            resumeQuiescent,
            requiresQuiescence && !resumeQuiescent
              ? "worker_not_quiescent"
              : undefined,
          );
        }
        if (isTurnCancelled(error) || prepared.executionSignal.aborted) {
          await lifecycle.interrupt(
            this.pendingInterrupts.get(turn.id) ??
              cancellationReason(prepared.executionSignal) ??
              (error instanceof Error ? error.message : "Run interrupted"),
          );
        } else {
          await this.recoverFailedTurn(lifecycle, error);
        }
      }
      throw error;
    } finally {
      this.activeContexts.delete(turn.id);
      this.compactedContexts.delete(turn.id);
      this.compactions.delete(turn.id);
      this.automaticCompactions.delete(turn.id);
      this.approvalCoordinators.delete(turn.id);
    }
  }

  private requireNativePorts(): { provider: ProviderPort; contextAssembly: ContextAssemblyPort; worker: WorkerProtocolPort; toolAuthorization: ToolAuthorizationPort } {
    const { provider, contextAssembly, worker, toolAuthorization } = this.dependencies;
    if (!provider || !contextAssembly || !worker || !toolAuthorization) throw new RuntimeKernelError("worker_failed", "Native execution requires its configured native ports");
    return { provider, contextAssembly, worker, toolAuthorization };
  }

  private async executeNativePreparedTurn(prepared: PreparedTurn) {
    const { run, turn, runAttemptId, workspace, tools } = prepared;
    if (!tools) throw new RuntimeKernelError("worker_failed", "Native tool ports are unavailable for this strategy");
    const context = await this.assembleContext(run, turn, workspace, [], prepared.executionSignal);
    this.activeContexts.set(turn.id, context);
    return this.executeLoop(prepared, run, runAttemptId, turn, workspace, context, tools);
  }

  private async runHooks(prepared: PreparedTurn): Promise<void> {
    const hooks = this.dependencies.hooks;
    if (!hooks || !prepared.workspace || !prepared.hookTriggerEvents) return;

    const base = {
      run: prepared.run,
      turn: prepared.turn,
      runAttemptId: prepared.runAttemptId,
      workspace: prepared.workspace,
      auditAppender: prepared.lifecycle,
    };
    await hooks.runSessionStart({
      ...base,
      triggerEventId: prepared.hookTriggerEvents.sessionStart.eventId,
    });
    await hooks.runUserPromptSubmit({
      ...base,
      triggerEventId: prepared.hookTriggerEvents.userPromptSubmit.eventId,
    });
  }

  async interruptTurn(turnId: Turn["id"], reason: string): Promise<void> {
    const lifecycle = this.lifecycles.get(turnId);
    if (!lifecycle) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} is not owned by this runtime kernel`,
      );
    }
    if (lifecycle.isTerminalDecided) return;

    this.pendingInterrupts.set(turnId, reason);
    this.executionControllers
      .get(turnId)
      ?.abort(new DOMException(reason, "AbortError"));
    const delegated = this.preparedTurns.get(turnId)?.delegated;
    if (delegated) await delegated.stop();
    const execution = this.executions.get(turnId);
    let executionSettled = !execution;
    if (execution) {
      try {
        if (this.dependencies.worker?.executionCapability === "guarded_mutation") {
          await execution;
        } else {
          await withBoundedCancellationSettlement(execution);
        }
        executionSettled = true;
      } catch (error) {
        if (!isTurnCancelled(error) && !lifecycle.isTerminal) {
          throw error;
        }
      }
    }

    if (!lifecycle.isTerminal) {
      const prepared = this.preparedTurns.get(turnId);
      if (!prepared) {
        throw new RuntimeKernelError(
          "turn_not_active",
          `Turn ${turnId} has not reached runtime preparation`,
        );
      }
      this.pendingInterrupts.delete(turnId);
      let quiescent = false;
      if (prepared.delegated) {
        try { await prepared.delegated.requireQuiescence(); quiescent = true; }
        catch { /* No release or immutable snapshot while mutation may continue. */ }
      } else {
        quiescent = executionSettled && (await this.dependencies.worker?.awaitQuiescence?.({ turnId, timeoutMs: 500 })) === true;
      }
      await this.interruptPreparedTurn(prepared, reason, quiescent);
    }
  }

  getTurnTerminalStatus(turnId: Turn["id"]): RuntimeLifecycleCoordinator["terminalStatus"] {
    return this.lifecycles.get(turnId)?.terminalStatus ?? null;
  }

  isTurnTerminal(turnId: Turn["id"]): boolean {
    return this.getTurnTerminalStatus(turnId) !== null;
  }

  isTurnReady(turnId: Turn["id"]): boolean {
    return this.lifecycles.has(turnId) && this.executions.has(turnId);
  }

  /**
   * Records an interrupt requested after this kernel was constructed but
   * before startTurn has created its lifecycle coordinator. The request is
   * consumed by startTurn and settled through the same canonical lifecycle.
   */
  requestInterruptBeforeStart(turnId: Turn["id"], reason: string): void {
    this.pendingInterrupts.set(turnId, reason);
  }

  private abortAllExecutions(reason: unknown): void {
    for (const controller of this.executionControllers.values()) {
      controller.abort(reason);
    }
  }

  async resolveApproval(
    turnId: Turn["id"],
    approvalId: Parameters<ApprovalCoordinator["resolve"]>[0],
    resolution: Parameters<ApprovalCoordinator["resolve"]>[1],
  ): Promise<void> {
    const approvals = this.approvalCoordinators.get(turnId);
    if (!approvals) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} is not owned by this runtime kernel`,
      );
    }
    await approvals.resolve(approvalId, resolution);
  }

  /** Bind this actual canonical callback into HarnessRecovery before retiring a
   * damaged journal. A physical stop alone is never a successful resolution. */
  async resolveObservationIntegrity(input: {
    readonly command: import("@repo/worker-protocol").HarnessStartCommand;
    readonly session: import("@repo/worker-protocol").HarnessSession;
    readonly signal: AbortSignal;
  }): Promise<import("./harness/DelegatedHarnessPort.js").HarnessObservationRecovery> {
    const delegated = this.preparedTurns.get(input.command.selection.turnId)?.delegated;
    if (!delegated) throw new RuntimeKernelError("turn_not_active", "No canonical delegated owner exists for integrity resolution");
    return delegated.resolveObservationIntegrity(input);
  }

  async respondUserInput(input: {
    readonly turnId: Turn["id"];
    readonly requestId: string;
    readonly response: import("@repo/platform-protocol").JsonRecord;
    readonly respondedBy: import("@repo/platform-protocol").UserId | null;
  }): Promise<void> {
    const delegated = this.preparedTurns.get(input.turnId)?.delegated;
    if (!delegated) throw new RuntimeKernelError("turn_not_active", "No active delegated user input owner");
    await delegated.respondUserInput(input.requestId, input.response, input.respondedBy);
  }

  async compactTurn(
    turnId: Turn["id"],
    mode: ContextCompactionMode,
  ): Promise<void> {
    const prepared = this.preparedTurns.get(turnId);
    const context = this.activeContexts.get(turnId);
    if (!prepared || !context || prepared.lifecycle.isTerminal) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} is not active in the runtime kernel`,
      );
    }
    const existing = this.compactions.get(turnId);
    if (existing) {
      await existing;
      return;
    }
    await this.runCompaction(prepared, context, mode);
  }

  private async executeLoop(
    prepared: PreparedTurn,
    run: Run,
    runAttemptId: StartTurnInput["runAttemptId"],
    turn: Turn,
    workspace: WorkspaceManifest | null,
    context: Awaited<ReturnType<ContextAssemblyPort["assemble"]>>,
    tools: ToolExecutionCoordinator,
  ): Promise<
    Omit<StartTurnResult, "workspace"> & { finalItemId: ProviderStepItemId }
  > {
    const toolResults: ToolResult[] = [];
    for (
      let toolCallCount = 0;
      toolCallCount <= this.maxToolCalls;
      toolCallCount += 1
    ) {
      prepared.executionSignal.throwIfAborted();
      const currentContext = this.activeContexts.get(turn.id) ?? context;
      const effectiveContext = this.compactedContexts.has(turn.id)
        ? currentContext
        : await this.assembleContext(
            run,
            turn,
            workspace,
            toolResults,
            prepared.executionSignal,
          );
      this.activeContexts.set(turn.id, effectiveContext);
      await this.maybeAutomaticallyCompact(prepared, effectiveContext);
      const providerInput = {
        run,
        runAttemptId,
        turn,
        workspace,
        context: this.activeContexts.get(turn.id) ?? effectiveContext,
        toolResults,
        signal: prepared.executionSignal,
        refreshContext: async () => {
          const refreshed = await this.assembleContext(
            run,
            turn,
            workspace,
            toolResults,
            prepared.executionSignal,
          );
          this.activeContexts.set(turn.id, refreshed);
          await this.maybeAutomaticallyCompact(prepared, refreshed);
          return this.activeContexts.get(turn.id) ?? refreshed;
        },
        onThreadInputsApplied: async (inputs: readonly import("./types.js").AppliedThreadInput[]) => {
          for (const input of inputs) {
            await prepared.lifecycle.applyThreadInput({
              inputId: input.inputId,
              acceptedSequence: input.acceptedSequence,
              modelStep: input.modelStep,
              contextRevision: input.contextRevision,
            });
          }
        },
      };
      let step: Awaited<ReturnType<ProviderPort["generateNext"]>>;
      try {
        prepared.executionSignal.throwIfAborted();
        step = await this.requireNativePorts().provider.generateNext(providerInput);
        prepared.executionSignal.throwIfAborted();
      } catch (error) {
        if (error instanceof RuntimeKernelError) throw error;
        throw new RuntimeKernelError(
          "provider_failed",
          error instanceof Error && error.message.trim()
            ? error.message
            : "Model provider request failed",
          error,
        );
      }
      if (step.usage) {
        const lifecycle = this.lifecycles.get(turn.id);
        if (!lifecycle) {
          throw new RuntimeKernelError(
            "turn_not_active",
            `Turn ${turn.id} has no lifecycle coordinator`,
          );
        }
        await lifecycle.updateUsage(step.usage);
        const latestContext =
          this.activeContexts.get(turn.id) ?? effectiveContext;
        const providerBudget = reconcileProviderContextBudget(
          latestContext.budgetSnapshot,
          step.usage,
        );
        if (providerBudget) {
          const measuredContext = {
            ...latestContext,
            budgetSnapshot: providerBudget,
          };
          this.activeContexts.set(turn.id, measuredContext);
          await lifecycle.updateContextBudget(providerBudget);
        }
      }
      if (step.kind === "complete") {
        const reserved = await prepared.lifecycle.reserveCompletion(
          () => this.requireNativePorts().provider.hasPendingThreadInputs?.() ?? false,
        );
        if (!reserved) {
          const flushed = await this.requireNativePorts().provider.flushThreadInputs?.();
          if (flushed) {
            toolCallCount -= 1;
            continue;
          }
          throw new RuntimeKernelError(
            "turn_not_active",
            `Turn ${turn.id} could not reserve terminal settlement`,
          );
        }
        if (step.reasoning) {
          const lifecycle = this.lifecycles.get(turn.id);
          if (!lifecycle) {
            throw new RuntimeKernelError(
              "turn_not_active",
              `Turn ${turn.id} has no lifecycle coordinator`,
            );
          }
          await lifecycle.appendAssistantReasoning(
            ItemIdSchema.parse(
              `itm_${turn.id.slice(4)}_reasoning_${toolCallCount}`,
            ),
            step.reasoning.text,
            step.reasoning.displaySafe,
          );
        }
        return {
          status: "completed",
          output: step.output,
          toolCallCount,
          finalItemId: step.itemId,
        };
      }
      if (toolCallCount === this.maxToolCalls) {
        throw new RuntimeKernelError(
          "tool_loop_limit_exceeded",
          `Turn ${turn.id} exceeded ${this.maxToolCalls} tool calls`,
        );
      }
      if (step.commentary) {
        const lifecycle = this.lifecycles.get(turn.id);
        if (!lifecycle) {
          throw new RuntimeKernelError(
            "turn_not_active",
            `Turn ${turn.id} has no lifecycle coordinator`,
          );
        }
        await lifecycle.appendAssistantCommentary(
          ItemIdSchema.parse(
            `itm_${turn.id.slice(4)}_commentary_${toolCallCount}`,
          ),
          step.commentary,
        );
      }
      if (step.reasoning) {
        const lifecycle = this.lifecycles.get(turn.id);
        if (!lifecycle) {
          throw new RuntimeKernelError(
            "turn_not_active",
            `Turn ${turn.id} has no lifecycle coordinator`,
          );
        }
        await lifecycle.appendAssistantReasoning(
          ItemIdSchema.parse(
            `itm_${turn.id.slice(4)}_reasoning_${toolCallCount}`,
          ),
          step.reasoning.text,
          step.reasoning.displaySafe,
        );
      }
      if (!workspace) {
        throw new RuntimeKernelError("tool_policy_denied", "Select a project before using repository tools.");
      }
      toolResults.push(
        await tools.execute(
          run,
          runAttemptId,
          turn,
          workspace,
          step.itemId,
          step.content,
          prepared.executionSignal,
        ),
      );
    }
    throw new RuntimeKernelError(
      "tool_loop_limit_exceeded",
      `Turn ${turn.id} exceeded its tool loop limit`,
    );
  }

  private async assembleContext(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest | null,
    toolResults: readonly ToolResult[],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ContextAssemblyPort["assemble"]>>> {
    const context = await this.requireNativePorts().contextAssembly.assemble({
      run,
      turn,
      workspace,
      toolResults,
      signal,
    });
    const lifecycle = this.lifecycles.get(turn.id);
    if (!lifecycle) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turn.id} has no lifecycle coordinator`,
      );
    }
    if (context.budgetSnapshot) {
      await lifecycle.updateContextBudget(context.budgetSnapshot);
    }
    if (context.usage) {
      await lifecycle.updateUsage(context.usage);
    }
    return context;
  }

  private async maybeAutomaticallyCompact(
    prepared: PreparedTurn,
    context: Awaited<ReturnType<ContextAssemblyPort["assemble"]>>,
  ): Promise<void> {
    const budget = context.budgetSnapshot;
    if (
      !budget ||
      budget.utilizationPercent < budget.automaticCompactionThresholdPercent ||
      this.automaticCompactions.has(prepared.turn.id)
    ) {
      return;
    }
    this.automaticCompactions.add(prepared.turn.id);
    await this.runCompaction(prepared, context, "automatic");
  }

  private async runCompaction(
    prepared: PreparedTurn,
    context: Awaited<ReturnType<ContextAssemblyPort["assemble"]>>,
    mode: ContextCompactionMode,
  ): Promise<void> {
    const existing = this.compactions.get(prepared.turn.id);
    if (existing) {
      await existing;
      return;
    }
    const operation = this.compactPreparedTurn(prepared, context, mode);
    this.compactions.set(prepared.turn.id, operation);
    try {
      await operation;
    } finally {
      this.compactions.delete(prepared.turn.id);
    }
  }

  private async compactPreparedTurn(
    prepared: PreparedTurn,
    context: Awaited<ReturnType<ContextAssemblyPort["assemble"]>>,
    mode: ContextCompactionMode,
  ): Promise<void> {
    const compaction = this.dependencies.contextCompaction;
    if (!compaction) {
      throw new RuntimeKernelError(
        "context_compaction_unsupported",
        "The active runtime does not support context compaction",
      );
    }
    const suffix = mode === "automatic" ? "automatic" : "manual";
    const itemId = ItemIdSchema.parse(
      `itm_${prepared.turn.id.slice(4)}_context_compaction_${suffix}`,
    );
    const compactionId = `cmp_${prepared.turn.id.slice(4)}_${suffix}`;
    const base = {
      compactionId,
      itemId,
      mode,
      phase: "compacting" as const,
      preservedContextReference: null,
      summary: null,
      error: null,
    };
    await prepared.lifecycle.requestContextCompaction(base);
    try {
      const result = await compaction.compact({
        run: prepared.run,
        turn: prepared.turn,
        context,
        mode,
        signal: prepared.executionSignal,
      });
      this.activeContexts.set(prepared.turn.id, result.context);
      this.compactedContexts.add(prepared.turn.id);
      if (result.context.budgetSnapshot) {
        await prepared.lifecycle.updateContextBudget(
          result.context.budgetSnapshot,
        );
      }
      await prepared.lifecycle.settleContextCompaction({
        ...base,
        phase: "compacted",
        preservedContextReference: result.preservedContextReference,
        summary: result.summary,
      });
    } catch (error) {
      await prepared.lifecycle.settleContextCompaction({
        ...base,
        phase: "failed",
        error:
          error instanceof Error ? error.message : "Context compaction failed",
      });
      throw error;
    }
  }

  /** Keep this kernel continuation and its prepared resources alive until the real worker drains. */
  private async awaitGuardedQuiescence(turnId: Turn["id"]): Promise<void> {
    const worker = this.dependencies.worker;
    if (!worker?.awaitQuiescence) {
      throw new RuntimeKernelError("worker_failed", "Captured worker has no physical quiescence port");
    }
    while (!(await worker.awaitQuiescence({ turnId, timeoutMs: 500 }))) {
      // A backend may return false immediately; yield without abandoning settlement ownership.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  private async interruptPreparedTurn(
    prepared: PreparedTurn,
    reason: string,
    resumeWorkspaceQuiescent: boolean,
  ): Promise<void> {
    if (this.dependencies.worker?.executionCapability === "guarded_mutation" && !resumeWorkspaceQuiescent) {
      await this.awaitGuardedQuiescence(prepared.turn.id);
      resumeWorkspaceQuiescent = true;
    }
    try {
      await this.settleArtifacts(
        prepared.turn.id,
        prepared.lifecycle,
        prepared.artifacts,
        true,
        resumeWorkspaceQuiescent,
        resumeWorkspaceQuiescent ? undefined : "worker_not_quiescent",
      );
      await prepared.lifecycle.interrupt(reason);
    } finally {
      this.approvalCoordinators.delete(prepared.turn.id);
    }
  }

  private assertTurnIdentity(run: Run, turn: Turn): void {
    if (turn.runId !== run.id || turn.threadId !== run.threadId) {
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        `Turn ${turn.id} does not belong to run ${run.id}`,
      );
    }
  }

  private async requireWorkspace(run: Run): Promise<WorkspaceManifest> {
    if (!this.workspaces) throw new RuntimeKernelError("workspace_not_found", "Repository execution requires a workspace owner.");
    const workspace = await this.workspaces.loadExecutableManifest(run.id);
    this.assertWorkspaceIdentity(run, workspace);
    return workspace;
  }

  private createArtifactSettlement(run: Run, turn: Turn, workspace: WorkspaceManifest) {
    if (!this.dependencies.gitSnapshots || !this.dependencies.turnArtifacts) {
      throw new RuntimeKernelError("turn_artifact_settlement_failed", "Repository execution requires Git and artifact owners.");
    }
    return new TurnArtifactSettlementCoordinator({
      git: this.dependencies.gitSnapshots, artifacts: this.dependencies.turnArtifacts,
      clock: this.clock, run, turn, workspace,
    });
  }

  private assertWorkspaceIdentity(
    run: Run,
    workspace: WorkspaceManifest,
  ): void {
    if (workspace.workspaceId !== run.workspaceId) {
      throw new RuntimeKernelError(
        "invalid_turn_identity",
        `Run ${run.id} workspace does not match durable manifest truth`,
      );
    }
  }

  private assertTurnAvailable(turn: Turn): void {
    if (this.lifecycles.has(turn.id)) {
      throw new RuntimeKernelError(
        "turn_already_owned",
        `Turn ${turn.id} already has a lifecycle coordinator`,
      );
    }
  }

  private createLifecycle(
    run: Run,
    turn: Turn,
    runAttemptId: StartTurnInput["runAttemptId"],
    input: StartTurnInput,
  ): RuntimeLifecycleCoordinator {
    this.assertTurnAvailable(turn);
    const lifecycle = new RuntimeLifecycleCoordinator({
      sink: this.dependencies.lifecycleEvents,
      producerId: this.dependencies.producerId,
      executionCapability: run.executionCapability,
      clock: this.clock,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      turnId: turn.id,
      runAttemptId,
      initialSequence: turn.lastEventSequence,
      revisionOfTurnId: turn.parentTurnId ?? undefined,
      continuationOfTurnId: input.continuationOfTurnId,
      originalPromptId: input.originalPromptId,
    });
    this.lifecycles.set(turn.id, lifecycle);
    return lifecycle;
  }

  private async recoverFailedTurn(
    lifecycle: RuntimeLifecycleCoordinator,
    error: unknown,
  ): Promise<void> {
    try {
      await lifecycle.fail(toProtocolError(error));
    } catch (settlementError) {
      if (settlementError instanceof RuntimeLifecycleSettlementError) {
        throw settlementError;
      }
      throw new RuntimeLifecycleSettlementError("failed", settlementError);
    }
  }

  private async settleArtifacts(
    turnId: Turn["id"],
    lifecycle: RuntimeLifecycleCoordinator,
    coordinator: TurnArtifactSettlementCoordinator | null,
    interruptedSettlement = false,
    preserveWorkspaceProgress = false,
    resumeUnavailableReason?: ResumeWorkspaceUnavailableReason,
  ): Promise<TurnArtifactSettlementResult> {
    if (!coordinator) return {};
    if (resumeUnavailableReason === "worker_not_quiescent") {
      if (!this.unsafeWorkspaces.has(turnId)) {
        await lifecycle.markWorkspaceSnapshotUnavailable("worker_not_quiescent");
        this.unsafeWorkspaces.add(turnId);
      }
      return { resumeUnavailableReason };
    }
    const existing = this.artifactSettlementEmissions.get(turnId);
    if (existing) return await existing;
    const settlement = this.settleArtifactsNow(
      lifecycle,
      coordinator,
      interruptedSettlement,
      preserveWorkspaceProgress,
      resumeUnavailableReason,
    );
    this.artifactSettlementEmissions.set(turnId, settlement);
    return await settlement;
  }

  private async settleArtifactsNow(
    lifecycle: RuntimeLifecycleCoordinator,
    coordinator: TurnArtifactSettlementCoordinator,
    interruptedSettlement: boolean,
    preserveWorkspaceProgress: boolean,
    resumeUnavailableReason?: ResumeWorkspaceUnavailableReason,
  ): Promise<TurnArtifactSettlementResult> {
    try {
      const settlement = await coordinator.settle({
        interrupted: interruptedSettlement,
        preserveWorkspaceProgress,
        resumeUnavailableReason,
      });
      if (!settlement.terminalSnapshot) {
        await lifecycle.markWorkspaceSnapshotUnavailable(
          settlement.resumeUnavailableReason ?? "snapshot_unavailable",
        );
        return settlement;
      }
      if (settlement.resumeWorkspaceArtifact) {
        await lifecycle.createTurnArtifact(settlement.resumeWorkspaceArtifact);
      }
      await lifecycle.captureWorkspaceSnapshot({
        snapshot: settlement.terminalSnapshot,
        ...(settlement.terminalSnapshotArtifact !== undefined
          ? { artifact: settlement.terminalSnapshotArtifact }
          : {}),
      });
      if (settlement.turnDiff) {
        await lifecycle.updateTurnDiff(settlement.turnDiff);
      }
      if (settlement.turnDiffArtifact) {
        await lifecycle.createTurnArtifact(settlement.turnDiffArtifact);
      }
      return settlement;
    } catch (error) {
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Turn artifacts could not be settled before the terminal event",
        error,
      );
    }
  }
}

function isTurnCancelled(error: unknown): error is RuntimeKernelError {
  return error instanceof RuntimeKernelError && error.code === "turn_cancelled";
}

function isArtifactSettlementError(error: unknown): boolean {
  return (
    error instanceof RuntimeKernelError &&
    error.code === "turn_artifact_settlement_failed"
  );
}

function cancellationReason(signal: AbortSignal): string | null {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }
  return null;
}

const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 2_000;

async function withBoundedCancellationSettlement<T>(
  operation: Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new RuntimeKernelError(
                "turn_cancelled",
                "Backend cancellation settlement timed out",
              ),
            ),
          CANCELLATION_SETTLEMENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type ProviderStepItemId = Extract<
  Awaited<ReturnType<ProviderPort["generateNext"]>>,
  { kind: "complete" }
>["itemId"];
