import {
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
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
  ProviderPort,
  RuntimeLifecycleEventStore,
  RuntimeGitSnapshotPort,
  RuntimeKernelClock,
  RuntimeTurnArtifactPort,
  ToolAuthorizationPort,
  WorkerProtocolPort,
} from "./ports.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import type { StartTurnInput, StartTurnResult, ToolResult } from "./types.js";
import { ToolExecutionCoordinator } from "./ToolExecutionCoordinator.js";
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
  readonly provider: ProviderPort;
  readonly worker: WorkerProtocolPort;
  readonly toolAuthorization: ToolAuthorizationPort;
  readonly approvals: ApprovalWaitPort;
  readonly producerId: string;
  readonly maxToolCalls?: number;
  readonly clock?: RuntimeKernelClock;
}

interface PreparedTurn {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: StartTurnInput["runAttemptId"];
  readonly workspace: WorkspaceManifest;
  readonly lifecycle: RuntimeLifecycleCoordinator;
  readonly artifacts: TurnArtifactSettlementCoordinator;
  readonly tools: ToolExecutionCoordinator;
}

export class RuntimeKernel {
  private readonly workspaces: WorkspaceCoordinator;
  private readonly maxToolCalls: number;
  private readonly clock: RuntimeKernelClock;
  private readonly lifecycles = new Map<string, RuntimeLifecycleCoordinator>();
  private readonly artifactSettlements = new Map<
    string,
    TurnArtifactSettlementCoordinator
  >();
  private readonly artifactSettlementEmissions = new Map<
    string,
    Promise<TurnArtifactSettlementResult>
  >();

  constructor(private readonly dependencies: RuntimeKernelDependencies) {
    this.workspaces = new WorkspaceCoordinator(dependencies.workspaceManifests);
    this.maxToolCalls = dependencies.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.clock = dependencies.clock ?? systemClock;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    return await this.executePreparedTurn(await this.prepareTurn(input));
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
    const tools = new ToolExecutionCoordinator(
      this.dependencies.worker,
      this.dependencies.toolAuthorization,
      approvals,
      lifecycle,
    );
    await lifecycle.start();
    await lifecycle.captureWorkspaceSnapshot(startArtifacts);
    return {
      run,
      turn,
      runAttemptId,
      workspace,
      lifecycle,
      artifacts: artifactSettlement,
      tools,
    };
  }

  private async executePreparedTurn(
    prepared: PreparedTurn,
  ): Promise<StartTurnResult> {
    const { run, turn, runAttemptId, workspace, lifecycle, artifacts, tools } =
      prepared;
    try {
      const context = await this.dependencies.contextAssembly.assemble({
        run,
        turn,
        workspace,
      });
      const result = await this.executeLoop(
        run,
        runAttemptId,
        turn,
        workspace,
        context,
        tools,
      );
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
        await this.recoverFailedTurn(lifecycle, error);
      }
      throw error;
    }
  }

  async interruptTurn(turnId: Turn["id"], reason: string): Promise<void> {
    const lifecycle = this.lifecycles.get(turnId);
    if (!lifecycle) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} is not owned by this runtime kernel`,
      );
    }
    const artifactSettlement = this.artifactSettlements.get(turnId);
    if (artifactSettlement) {
      try {
        await this.settleArtifacts(turnId, lifecycle, artifactSettlement);
      } catch (error) {
        await this.recoverFailedTurn(lifecycle, error);
        throw error;
      }
    }
    await lifecycle.interrupt(reason);
  }

  private async executeLoop(
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
      const step = await this.dependencies.provider.generateNext({
        run,
        runAttemptId,
        turn,
        workspace,
        context,
        toolResults,
      });
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
      toolResults.push(
        await tools.execute(
          run,
          runAttemptId,
          turn,
          workspace,
          step.itemId,
          step.content,
        ),
      );
    }
    throw new RuntimeKernelError(
      "tool_loop_limit_exceeded",
      `Turn ${turn.id} exceeded its tool loop limit`,
    );
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

function isArtifactSettlementError(error: unknown): boolean {
  return (
    error instanceof RuntimeKernelError &&
    error.code === "turn_artifact_settlement_failed"
  );
}

type ProviderStepItemId = Extract<
  Awaited<ReturnType<ProviderPort["generateNext"]>>,
  { kind: "complete" }
>["itemId"];
