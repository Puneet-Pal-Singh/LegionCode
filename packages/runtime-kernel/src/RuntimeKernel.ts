import {
  RunSchema,
  TurnSchema,
  type Run,
  type Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifestRepository } from "@repo/workspace-core";
import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
import { RuntimeKernelError, toProtocolError } from "./errors.js";
import type {
  ApprovalWaitPort,
  ContextAssemblyPort,
  ProviderPort,
  RuntimeKernelClock,
  WorkerProtocolPort,
} from "./ports.js";
import { RuntimeEventEmitter } from "./RuntimeEventEmitter.js";
import type { StartTurnInput, StartTurnResult, ToolResult } from "./types.js";
import { ToolExecutionCoordinator } from "./ToolExecutionCoordinator.js";
import { WorkspaceCoordinator } from "./WorkspaceCoordinator.js";

const DEFAULT_MAX_TOOL_CALLS = 32;
const systemClock: RuntimeKernelClock = { now: () => new Date().toISOString() };

export interface RuntimeKernelDependencies {
  readonly eventStore: ConstructorParameters<typeof RuntimeEventEmitter>[0];
  readonly workspaceManifests: WorkspaceManifestRepository;
  readonly contextAssembly: ContextAssemblyPort;
  readonly provider: ProviderPort;
  readonly worker: WorkerProtocolPort;
  readonly approvals: ApprovalWaitPort;
  readonly producerId: string;
  readonly maxToolCalls?: number;
  readonly clock?: RuntimeKernelClock;
}

export class RuntimeKernel {
  private readonly events: RuntimeEventEmitter;
  private readonly approvals: ApprovalCoordinator;
  private readonly workspaces: WorkspaceCoordinator;
  private readonly tools: ToolExecutionCoordinator;
  private readonly maxToolCalls: number;
  private readonly clock: RuntimeKernelClock;

  constructor(private readonly dependencies: RuntimeKernelDependencies) {
    this.events = new RuntimeEventEmitter(
      dependencies.eventStore,
      dependencies.producerId,
    );
    this.approvals = new ApprovalCoordinator(
      dependencies.approvals,
      this.events,
    );
    this.workspaces = new WorkspaceCoordinator(dependencies.workspaceManifests);
    this.tools = new ToolExecutionCoordinator(
      dependencies.worker,
      this.approvals,
      this.events,
    );
    this.maxToolCalls = dependencies.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.clock = dependencies.clock ?? systemClock;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const run = RunSchema.parse(input.run);
    const turn = TurnSchema.parse(input.turn);
    this.assertTurnIdentity(run, turn);
    const runningTurn = this.transitionTurn(turn, "running");
    await this.events.turnStarted(run, runningTurn);

    try {
      const workspace = await this.workspaces.loadExecutableManifest(run.id);
      this.assertWorkspaceIdentity(run, workspace);
      const context = await this.dependencies.contextAssembly.assemble({
        run,
        turn: runningTurn,
        workspace,
      });
      const result = await this.executeLoop(
        run,
        runningTurn,
        workspace,
        context,
      );
      await this.events.turnCompleted(
        run,
        this.transitionTurn(runningTurn, "completed"),
      );
      return { ...result, workspace };
    } catch (error) {
      await this.events.turnFailed(
        run,
        this.transitionTurn(runningTurn, "failed"),
        toProtocolError(error),
      );
      throw error;
    }
  }

  private async executeLoop(
    run: Run,
    turn: Turn,
    workspace: StartTurnResult["workspace"],
    context: Awaited<ReturnType<ContextAssemblyPort["assemble"]>>,
  ): Promise<Omit<StartTurnResult, "workspace">> {
    const toolResults: ToolResult[] = [];
    for (
      let toolCallCount = 0;
      toolCallCount <= this.maxToolCalls;
      toolCallCount += 1
    ) {
      const step = await this.dependencies.provider.generateNext({
        run,
        turn,
        workspace,
        context,
        toolResults,
      });
      if (step.kind === "complete") {
        return { status: "completed", output: step.output, toolCallCount };
      }
      if (toolCallCount === this.maxToolCalls) {
        throw new RuntimeKernelError(
          "tool_loop_limit_exceeded",
          `Turn ${turn.id} exceeded ${this.maxToolCalls} tool calls`,
        );
      }
      toolResults.push(
        await this.tools.execute(
          run,
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

  private transitionTurn(turn: Turn, status: Turn["status"]): Turn {
    const now = this.clock.now();
    return {
      ...turn,
      status,
      startedAt: status === "running" ? now : turn.startedAt,
      completedAt: status === "completed" || status === "failed" ? now : null,
      updatedAt: now,
    };
  }
}
