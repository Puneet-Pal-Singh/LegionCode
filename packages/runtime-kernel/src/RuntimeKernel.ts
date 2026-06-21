import {
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
  type Run,
  type Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifestRepository } from "@repo/workspace-core";
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
  RuntimeKernelClock,
  ToolAuthorizationPort,
  WorkerProtocolPort,
} from "./ports.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import type { StartTurnInput, StartTurnResult, ToolResult } from "./types.js";
import { ToolExecutionCoordinator } from "./ToolExecutionCoordinator.js";
import { WorkspaceCoordinator } from "./WorkspaceCoordinator.js";

const DEFAULT_MAX_TOOL_CALLS = 32;
const systemClock: RuntimeKernelClock = { now: () => new Date().toISOString() };

export interface RuntimeKernelDependencies {
  readonly lifecycleEvents: RuntimeLifecycleEventStore;
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

export class RuntimeKernel {
  private readonly workspaces: WorkspaceCoordinator;
  private readonly maxToolCalls: number;
  private readonly clock: RuntimeKernelClock;
  private readonly lifecycles = new Map<string, RuntimeLifecycleCoordinator>();

  constructor(private readonly dependencies: RuntimeKernelDependencies) {
    this.workspaces = new WorkspaceCoordinator(dependencies.workspaceManifests);
    this.maxToolCalls = dependencies.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.clock = dependencies.clock ?? systemClock;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const run = RunSchema.parse(input.run);
    const turn = TurnSchema.parse(input.turn);
    const runAttemptId = RunAttemptIdSchema.parse(input.runAttemptId);
    this.assertTurnIdentity(run, turn);
    const lifecycle = this.createLifecycle(run, turn, runAttemptId);
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

    try {
      const workspace = await this.workspaces.loadExecutableManifest(run.id);
      this.assertWorkspaceIdentity(run, workspace);
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
      await lifecycle.complete(result.output, result.finalItemId);
      return {
        status: result.status,
        output: result.output,
        toolCallCount: result.toolCallCount,
        workspace,
      };
    } catch (error) {
      if (!lifecycle.isTerminal) {
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

  private createLifecycle(
    run: Run,
    turn: Turn,
    runAttemptId: StartTurnInput["runAttemptId"],
  ): RuntimeLifecycleCoordinator {
    if (this.lifecycles.has(turn.id)) {
      throw new RuntimeKernelError(
        "turn_already_owned",
        `Turn ${turn.id} already has a lifecycle coordinator`,
      );
    }
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
}

type ProviderStepItemId = Extract<
  Awaited<ReturnType<ProviderPort["generateNext"]>>,
  { kind: "complete" }
>["itemId"];
