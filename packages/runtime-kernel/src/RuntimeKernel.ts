import {
  ItemIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
  LifecycleTransitionError,
  type LifecycleEvent,
  type Run,
  type Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifestRepository } from "@repo/workspace-core";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
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
import type { StartTurnInput, StartTurnResult, ToolResult } from "./types.js";
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
  readonly gitSnapshots: RuntimeGitSnapshotPort;
  readonly turnArtifacts: RuntimeTurnArtifactPort;
  readonly workspaceManifests: WorkspaceManifestRepository;
  readonly contextAssembly: ContextAssemblyPort;
  readonly contextCompaction?: ContextCompactionPort;
  readonly provider: ProviderPort;
  readonly worker: WorkerProtocolPort;
  readonly toolAuthorization: ToolAuthorizationPort;
  readonly approvals: ApprovalWaitPort;
  readonly hooks?: RuntimeHookOrchestrationPort;
  readonly producerId: string;
  readonly maxToolCalls?: number;
  readonly clock?: RuntimeKernelClock;
  readonly signal?: AbortSignal;
}

interface PreparedTurn {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: StartTurnInput["runAttemptId"];
  readonly workspace: WorkspaceManifest;
  readonly lifecycle: RuntimeLifecycleCoordinator;
  readonly artifacts: TurnArtifactSettlementCoordinator;
  readonly tools: ToolExecutionCoordinator;
  readonly hookTriggerEvents: {
    readonly sessionStart: LifecycleEvent;
    readonly userPromptSubmit: LifecycleEvent;
  };
}

export class RuntimeKernel {
  private readonly workspaces: WorkspaceCoordinator;
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
  private readonly interruptController = new AbortController();
  private readonly executionSignal: AbortSignal;

  constructor(private readonly dependencies: RuntimeKernelDependencies) {
    this.workspaces = new WorkspaceCoordinator(dependencies.workspaceManifests);
    this.maxToolCalls = dependencies.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.clock = dependencies.clock ?? systemClock;
    this.executionSignal = this.interruptController.signal;
    if (dependencies.signal) {
      if (dependencies.signal.aborted) {
        this.interruptController.abort(dependencies.signal.reason);
      } else {
        dependencies.signal.addEventListener(
          "abort",
          () => this.interruptController.abort(dependencies.signal?.reason),
          { once: true },
        );
      }
    }
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const prepared = await this.prepareTurn(input);
    this.preparedTurns.set(prepared.turn.id, prepared);
    const pendingReason = this.pendingInterrupts.get(prepared.turn.id);
    if (pendingReason) {
      this.pendingInterrupts.delete(prepared.turn.id);
      await this.interruptPreparedTurn(prepared, pendingReason);
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
      this.preparedTurns.delete(prepared.turn.id);
    }
  }

  private async prepareTurn(input: StartTurnInput): Promise<PreparedTurn> {
    const run = RunSchema.parse(input.run);
    const turn = TurnSchema.parse(input.turn);
    const runAttemptId = RunAttemptIdSchema.parse(input.runAttemptId);
    this.assertTurnIdentity(run, turn);
    this.assertTurnAvailable(turn);
    const workspace = await this.workspaces.loadExecutableManifest(run.id);
    this.assertWorkspaceIdentity(run, workspace);
    const artifactSettlement = new TurnArtifactSettlementCoordinator({
      git: this.dependencies.gitSnapshots,
      artifacts: this.dependencies.turnArtifacts,
      clock: this.clock,
      run,
      turn,
      workspace,
    });
    const startArtifacts = await artifactSettlement.begin();
    const lifecycle = this.createLifecycle(run, turn, runAttemptId);
    this.artifactSettlements.set(turn.id, artifactSettlement);
    const approvals = new ApprovalCoordinator(
      this.dependencies.approvals,
      lifecycle,
    );
    this.approvalCoordinators.set(turn.id, approvals);
    const tools = new ToolExecutionCoordinator(
      this.dependencies.worker,
      this.dependencies.toolAuthorization,
      approvals,
      lifecycle,
    );
    const lifecycleStart = await lifecycle.start();
    await lifecycle.captureWorkspaceSnapshot(startArtifacts);
    return {
      run,
      turn,
      runAttemptId,
      workspace,
      lifecycle,
      artifacts: artifactSettlement,
      tools,
      hookTriggerEvents: {
        sessionStart: lifecycleStart.turnStarted,
        userPromptSubmit: lifecycleStart.runAttemptStarted,
      },
    };
  }

  private async executePreparedTurn(
    prepared: PreparedTurn,
  ): Promise<StartTurnResult> {
    const { run, turn, runAttemptId, workspace, lifecycle, artifacts, tools } =
      prepared;
    try {
      if (lifecycle.isTerminal) {
        return {
          status: "completed",
          output: "",
          toolCallCount: 0,
          workspace,
        };
      }
      await this.runHooks(prepared);
      const context = await this.assembleContext(run, turn, workspace, []);
      this.activeContexts.set(turn.id, context);
      const result = await this.executeLoop(
        prepared,
        run,
        runAttemptId,
        turn,
        workspace,
        context,
        tools,
      );
      if (this.executionSignal.aborted || lifecycle.isTerminal) {
        throw new LifecycleTransitionError(
          "turn",
          "interrupted",
          "completed",
          "turn was interrupted before successful settlement",
        );
      }
      await this.settleArtifacts(turn.id, lifecycle, artifacts);
      await lifecycle.complete(result.output, result.finalItemId);
      return {
        status: result.status,
        output: result.output,
        toolCallCount: result.toolCallCount,
        workspace,
      };
    } catch (error) {
      if (!lifecycle.isTerminal) {
        if (!isArtifactSettlementError(error)) {
          await this.settleArtifacts(turn.id, lifecycle, artifacts);
        }
        if (isTurnCancelled(error) || this.executionSignal.aborted) {
          await lifecycle.interrupt(
            this.pendingInterrupts.get(turn.id) ??
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

  private async runHooks(prepared: PreparedTurn): Promise<void> {
    const hooks = this.dependencies.hooks;
    if (!hooks) return;

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
    if (lifecycle.isTerminal) return;

    this.pendingInterrupts.set(turnId, reason);
    this.interruptController.abort(new DOMException(reason, "AbortError"));
    const execution = this.executions.get(turnId);
    if (execution) {
      try {
        await withBoundedCancellationSettlement(execution);
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
      await this.interruptPreparedTurn(prepared, reason);
    }
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
    workspace: StartTurnResult["workspace"],
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
      const currentContext = this.activeContexts.get(turn.id) ?? context;
      const effectiveContext = this.compactedContexts.has(turn.id)
        ? currentContext
        : await this.assembleContext(run, turn, workspace, toolResults);
      this.activeContexts.set(turn.id, effectiveContext);
      await this.maybeAutomaticallyCompact(prepared, effectiveContext);
      let step: Awaited<ReturnType<ProviderPort["generateNext"]>>;
      try {
        step = await this.dependencies.provider.generateNext({
          run,
          runAttemptId,
          turn,
          workspace,
          context: this.activeContexts.get(turn.id) ?? effectiveContext,
          toolResults,
          signal: this.executionSignal,
        });
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
        const providerBudget = reconcileProviderContextBudget(
          effectiveContext.budgetSnapshot,
          step.usage,
        );
        if (providerBudget) {
          const measuredContext = {
            ...effectiveContext,
            budgetSnapshot: providerBudget,
          };
          this.activeContexts.set(turn.id, measuredContext);
          await lifecycle.updateContextBudget(providerBudget);
        }
      }
      if (step.kind === "complete") {
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
      toolResults.push(
        await tools.execute(
          run,
          runAttemptId,
          turn,
          workspace,
          step.itemId,
          step.content,
          this.dependencies.signal,
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
    workspace: WorkspaceManifest,
    toolResults: readonly ToolResult[],
  ): Promise<Awaited<ReturnType<ContextAssemblyPort["assemble"]>>> {
    const context = await this.dependencies.contextAssembly.assemble({
      run,
      turn,
      workspace,
      toolResults,
      signal: this.executionSignal,
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
        signal: this.executionSignal,
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

  private async interruptPreparedTurn(
    prepared: PreparedTurn,
    reason: string,
  ): Promise<void> {
    try {
      await this.settleArtifacts(
        prepared.turn.id,
        prepared.lifecycle,
        prepared.artifacts,
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

  private assertWorkspaceIdentity(
    run: Run,
    workspace: StartTurnResult["workspace"],
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
  ): RuntimeLifecycleCoordinator {
    this.assertTurnAvailable(turn);
    const lifecycle = new RuntimeLifecycleCoordinator({
      sink: this.dependencies.lifecycleEvents,
      producerId: this.dependencies.producerId,
      clock: this.clock,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      turnId: turn.id,
      runAttemptId,
      initialSequence: turn.lastEventSequence,
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
    coordinator: TurnArtifactSettlementCoordinator,
  ): Promise<TurnArtifactSettlementResult> {
    const existing = this.artifactSettlementEmissions.get(turnId);
    if (existing) return await existing;
    const settlement = this.settleArtifactsNow(lifecycle, coordinator);
    this.artifactSettlementEmissions.set(turnId, settlement);
    return await settlement;
  }

  private async settleArtifactsNow(
    lifecycle: RuntimeLifecycleCoordinator,
    coordinator: TurnArtifactSettlementCoordinator,
  ): Promise<TurnArtifactSettlementResult> {
    try {
      const settlement = await coordinator.settle();
      await lifecycle.captureWorkspaceSnapshot({
        snapshot: settlement.terminalSnapshot,
        artifact: settlement.terminalSnapshotArtifact,
      });
      await lifecycle.updateTurnDiff(settlement.turnDiff);
      await lifecycle.createTurnArtifact(settlement.turnDiffArtifact);
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
