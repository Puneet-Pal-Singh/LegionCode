import type { CoreMessage, CoreTool } from "ai";
import {
  ItemIdSchema,
  JsonRecordSchema,
  PermissionProfileIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  ThreadIdSchema,
  ToolCallItemContentSchema,
  TurnSchema,
  WorkerIdSchema,
  type ApprovalDecision,
  type ApprovalRequestedPayload,
  type Run as ProtocolRun,
  type RunAttemptId,
  type ThreadId,
  type ToolCallItemContent,
  type Turn,
  projectVisibleTranscriptText,
} from "@repo/platform-protocol";
import type {
  ApprovalResolution,
  ApprovalWaitPort,
  ContextAssemblyPort,
  ProviderCallInput,
  ProviderPort,
  ProviderStep,
  RuntimeGitSnapshotPort,
  RuntimeKernelDependencies,
  RuntimeLifecycleEventStore,
  RuntimeTurnArtifactPort,
  ToolResult,
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import { RuntimeKernel, RuntimeKernelError } from "@repo/runtime-kernel";
import {
  RISKY_ACTION_CATEGORIES,
  RUN_WORKFLOW_STEPS,
  type ApprovalRequest,
  RUN_TERMINAL_STATES,
} from "@repo/shared-types";
import type { PermissionPolicy, RuleSetPolicy } from "@repo/permission-policy";
import { BaseAgent } from "../agents/BaseAgent.js";
import {
  enforceCodingToolFloor,
  getCodingCoreToolRegistry,
  isCodingToolId,
  isMutatingCodingToolId,
} from "../tools/CodingToolRegistry.js";
import type {
  AgenticLoopToolLifecycleEvent,
  IAgent,
  RunInput,
  RuntimeDurableObjectState,
  RuntimeExecutionService,
  TaskResult,
} from "../types.js";
import { Run, RunRepository, RunStateMachine } from "../run/index.js";
import { TaskRepository } from "../task/index.js";
import { RunEventRecorder, RunEventRepository } from "../events/index.js";
import { MemoryCoordinator, MemoryRepository } from "../memory/index.js";
import { LLMGateway, type ILLMGateway } from "../llm/index.js";
import { PlannerService } from "../planner/index.js";
import {
  BudgetManager,
  CostLedger,
  CostTracker,
  PricingRegistry,
  PricingResolver,
  type BudgetPolicy,
  type IBudgetManager,
  type ICostLedger,
  type ICostTracker,
  type IPricingRegistry,
  type IPricingResolver,
} from "../cost/index.js";
import {
  buildAgenticLoopSystemPrompt,
  buildAssistantMessage,
  buildToolResultMessage,
  type AgenticLoopToolCall,
  type AgenticLoopToolResult,
  type StopReason,
} from "./AgenticLoop.js";
import {
  buildAgenticLoopFinalMessage,
  getAgenticLoopMaxSteps,
  recordAgenticLoopMetadata,
} from "./RunAgenticLoopPolicy.js";
import { buildAgenticLoopWorkspaceContext } from "./RunContinuationContext.js";
import { createRunManifest, ensureManifestMatch } from "./RunManifestPolicy.js";
import {
  createStreamResponse,
  finalizeRunWithAssistantMessage,
  type RunCompletionDependencies,
} from "./RunCompletionPolicy.js";
import {
  recordLifecycleStep,
  recordOrchestrationActivation,
  recordPhaseSelectionSnapshot,
  recordTurnModeDecision,
} from "./RunMetadataPolicy.js";
import { recordInitialTurnActivity } from "./RunInitialActivityPolicy.js";
import {
  buildPlanModeResponse,
  persistPlanArtifact,
} from "./RunPlanModePolicy.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import { describeWorkspaceBootstrapSummary } from "./RunWorkspaceBootstrapSummaryPolicy.js";
import {
  ensureApprovalResolvedEventRecorded,
  waitForApprovalDecision,
} from "./RunApprovalWaitPolicy.js";
import {
  resolveBudgetConfig,
  resolveUnknownPricingMode,
} from "./RunEngineConfigPolicy.js";
import { evaluateWorkspaceBootstrap } from "./RunPermissionWorkspacePolicy.js";
import type {
  RunEngineDependencies,
  RunEngineOptions,
} from "./RunEngineTypes.js";
import { RegistryToolAuthorization } from "../contracts/RegistryToolAuthorization.js";
import { resetRecyclableRun } from "./RunRecyclableResetPolicy.js";
import { resolveRunPermissionContext } from "./RunPermissionContextPolicy.js";
import { formatRuntimeDiagnosticLogLine } from "../lib/RuntimeDiagnosticLog.js";
import { createCloudSandboxRunCapabilityManifest } from "../capabilities/RuntimeCapabilityManifest.js";
import { RuntimeToolGateway } from "./RuntimeToolGateway.js";
import { RuntimeWorkspaceScope } from "./RuntimeWorkspaceScope.js";

const DEFAULT_SHA = "0".repeat(40);
const NATIVE_CANCELLATION_POLL_INTERVAL_MS = 2_000;
type KernelWorkspaceManifest = NonNullable<
  Awaited<
    ReturnType<
      RuntimeKernelDependencies["workspaceManifests"]["getLatestByRunId"]
    >
  >
>;

export interface RuntimeKernelNativeRunnerInput {
  input: RunInput;
  messages: CoreMessage[];
  tools: Record<string, CoreTool>;
  lifecycleEvents: RuntimeLifecycleEventStore;
  turnId: Turn["id"];
  runAttemptId?: string;
  threadId?: string;
  workspaceId?: string;
  now?: () => string;
}

export class RuntimeKernelNativeRunner {
  private readonly runRepo: RunRepository;
  private readonly taskRepo: TaskRepository;
  private readonly runEventRecorder: RunEventRecorder;
  private readonly eventRepo: RunEventRepository;
  private readonly memoryCoordinator: MemoryCoordinator;
  private readonly pricingRegistry: IPricingRegistry;
  private readonly costLedger: ICostLedger;
  private readonly costTracker: ICostTracker;
  private readonly budgetManager: IBudgetManager & BudgetPolicy;
  private readonly llmGateway: ILLMGateway;
  private readonly permissionApprovalStore: PermissionApprovalStore;
  private readonly planner: PlannerService;
  private readonly workspaceBootstrapper;

  constructor(
    ctx: RuntimeDurableObjectState,
    private readonly options: RunEngineOptions,
    private readonly agent: IAgent | undefined,
    dependencies: RunEngineDependencies = {},
  ) {
    this.runRepo = new RunRepository(ctx);
    this.taskRepo = new TaskRepository(ctx);
    this.permissionApprovalStore = new PermissionApprovalStore(
      ctx,
      options.runId,
    );
    const eventRepo = new RunEventRepository(ctx);
    this.eventRepo = eventRepo;
    this.runEventRecorder = new RunEventRecorder(
      eventRepo,
      options.runId,
      options.sessionId,
      dependencies.runEventListener,
    );
    this.pricingRegistry =
      dependencies.pricingRegistry ??
      new PricingRegistry(undefined, {
        failOnUnseededPricing:
          options.env.COST_FAIL_ON_UNSEEDED_PRICING === "true",
      });
    this.costLedger = dependencies.costLedger ?? new CostLedger(ctx);
    this.costTracker =
      dependencies.costTracker ??
      new CostTracker(
        ctx,
        this.pricingRegistry,
        resolveUnknownPricingMode(options.env),
      );
    this.budgetManager =
      dependencies.budgetManager ??
      new BudgetManager(
        this.costTracker,
        this.pricingRegistry,
        resolveBudgetConfig(options.env),
        ctx,
      );
    const pricingResolver =
      dependencies.pricingResolver ??
      new PricingResolver(this.pricingRegistry, {
        unknownPricingMode: resolveUnknownPricingMode(options.env),
      });
    this.llmGateway =
      dependencies.llmGateway ??
      new LLMGateway({
        aiService: requireAiService(dependencies),
        budgetPolicy: this.budgetManager,
        costLedger: this.costLedger,
        pricingResolver,
      });
    this.planner = dependencies.planner ?? new PlannerService(this.llmGateway);
    this.workspaceBootstrapper = dependencies.workspaceBootstrapper;
    this.memoryCoordinator =
      dependencies.memoryCoordinator ??
      new MemoryCoordinator({
        repository: new MemoryRepository({ ctx }),
        sessionMemoryClient: dependencies.sessionMemoryClient,
      });
  }

  async execute(input: RuntimeKernelNativeRunnerInput): Promise<Response> {
    await this.budgetManager.loadSessionCosts();
    const run = await this.getOrCreateRun(input.input);
    await this.prepareRun(run, input);
    if (run.metadata.manifest?.mode !== "build") {
      return await this.executePlanMode(run, input.input);
    }
    const bootstrapResponse = await this.prepareBuildWorkspace(
      run,
      input.input,
    );
    if (bootstrapResponse) {
      return bootstrapResponse;
    }
    await this.activateBuildRun(run);
    const executionService = this.getDirectExecutionService();
    const runtimeTools = enforceCodingToolFloor(
      { ...getCodingCoreToolRegistry(), ...input.tools },
      input.input.metadata,
    );
    recordTurnModeDecision(run, {
      mode: "action",
      source: "runtime-kernel",
      rationale: "Build turns use the canonical runtime kernel path.",
      confidence: 1,
    });
    recordPhaseSelectionSnapshot(run, "execution");
    console.log(
      formatRuntimeDiagnosticLogLine(
        "runtime-kernel/native",
        "build-path-selected",
        {
          runId: this.options.runId,
          sessionId: this.options.sessionId,
          promptChars: input.input.prompt.length,
          inputToolCount: Object.keys(input.tools).length,
          runtimeToolCount: Object.keys(runtimeTools).length,
        },
      ),
    );
    await this.runRepo.update(run);
    const now = input.now ?? (() => new Date().toISOString());
    const protocol = buildProtocolEnvelope({
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      userId: this.options.userId,
      input: input.input,
      turnId: input.turnId,
      timestamp: now(),
      canonicalRunAttemptId: input.runAttemptId,
      canonicalThreadId: input.threadId,
      canonicalWorkspaceId: input.workspaceId,
    });
    const provider = new KernelAgenticProvider({
      run,
      input: input.input,
      messages: input.messages,
      tools: runtimeTools,
      llmGateway: this.llmGateway,
      budget: this.budgetManager,
      runRepo: this.runRepo,
      runEventRecorder: this.runEventRecorder,
      isRunCancelled: this.isRunCancelled.bind(this),
    });
    const capabilityManifest = createCloudSandboxRunCapabilityManifest({
      runId: protocol.run.id,
      workspaceRoot: protocol.manifest.filesystemRoot,
      availableToolIds: Object.keys(runtimeTools),
      providerId: input.input.providerId,
      modelId: input.input.runtimeModelId ?? input.input.modelId,
    });
    const worker = new KernelToolWorker({
      runEventRecorder: this.runEventRecorder,
      tracker: provider,
      isRunCancelled: this.isRunCancelled.bind(this),
      toolGateway: new RuntimeToolGateway({
        executor: executionService,
        manifest: capabilityManifest,
        scope: new RuntimeWorkspaceScope({
          runId: protocol.run.id,
          runAttemptId: protocol.runAttemptId,
          workspaceId: protocol.manifest.workspaceId,
          root: protocol.manifest.filesystemRoot,
        }),
      }),
    });
    const kernel = new RuntimeKernel({
      lifecycleEvents: input.lifecycleEvents,
      workspaceManifests: createWorkspaceManifestRepository(protocol.manifest),
      gitSnapshots: createSnapshotPort(protocol.manifest),
      turnArtifacts: createTurnArtifactPort(),
      contextAssembly: createContextAssembly(input.input),
      provider,
      worker,
      toolAuthorization: new RegistryToolAuthorization(
        new NativePermissionPolicyResolver(),
      ),
      approvals: new NativeApprovalWaitPort({
        env: this.options.env,
        runId: this.options.runId,
        sessionId: this.options.sessionId,
        ownerUserId: this.options.userId,
        runRepo: this.runRepo,
        runEventRecorder: this.runEventRecorder,
        permissionApprovalStore: this.permissionApprovalStore,
      }),
      producerId: "runtime-kernel-native",
      maxToolCalls: getAgenticLoopMaxSteps(input.input.metadata),
      clock: { now },
    });
    const result = await this.startKernelTurn(kernel, protocol, run, provider);
    if (result instanceof Response) {
      return result;
    }
    if (await this.isRunCancelled()) {
      provider.recordCancelled();
      recordAgenticLoopMetadata(run, provider.buildResult());
      return createStreamResponse("");
    }
    const finalMessage = buildAgenticLoopFinalMessage(provider.buildResult());
    recordAgenticLoopMetadata(run, provider.buildResult());
    const response = await finalizeRunWithAssistantMessage({
      run,
      text: finalMessage.text || result.output,
      metadata: {
        ...(finalMessage.metadata ?? {}),
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
      },
      deps: this.getRunCompletionDependencies(),
    });
    return response;
  }

  private async executePlanMode(run: Run, input: RunInput): Promise<Response> {
    const previousStatus = run.status;
    if (run.status === "CREATED") {
      run.transition("PLANNING");
    }
    recordPhaseSelectionSnapshot(run, "planning");
    await this.runEventRecorder.recordRunStatusChanged(
      previousStatus,
      run.status,
      RUN_WORKFLOW_STEPS.PLANNING,
    );
    await this.runRepo.update(run);
    const plan = this.agent
      ? await this.agent.plan({ run, prompt: input.prompt, history: undefined })
      : await this.planner.plan(run, input.prompt, undefined);
    const planArtifact = persistPlanArtifact(run, plan);
    recordLifecycleStep(run, "PLAN_VALIDATED");
    return await finalizeRunWithAssistantMessage({
      run,
      text: buildPlanModeResponse(planArtifact),
      deps: this.getRunCompletionDependencies(),
    });
  }

  private async startKernelTurn(
    kernel: RuntimeKernel,
    protocol: {
      run: ProtocolRun;
      turn: Turn;
      runAttemptId: RunAttemptId;
    },
    run: Run,
    provider: KernelAgenticProvider,
  ) {
    try {
      console.log(
        formatRuntimeDiagnosticLogLine(
          "runtime-kernel/native",
          "turn-started",
          {
            runId: run.id,
            sessionId: run.sessionId,
            turnId: protocol.turn.id,
          },
        ),
      );
      return await kernel.startTurn(protocol);
    } catch (error) {
      if (error instanceof NativeRunCancelledError) {
        console.log(
          formatRuntimeDiagnosticLogLine(
            "runtime-kernel/native",
            "turn-cancelled",
            {
              runId: run.id,
              sessionId: run.sessionId,
              turnId: protocol.turn.id,
            },
          ),
        );
        await kernel.interruptTurn(protocol.turn.id, "Run cancelled by user.");
        provider.recordCancelled();
        recordAgenticLoopMetadata(run, provider.buildResult());
        return createStreamResponse("");
      }
      provider.recordTerminalError(error);
      recordAgenticLoopMetadata(run, provider.buildResult());
      const terminalState = resolveNativeKernelTerminalState(error);
      const message = buildNativeKernelTerminalMessage(error, terminalState);
      console.error(
        formatRuntimeDiagnosticLogLine("runtime-kernel/native", "turn-failed", {
          runId: run.id,
          sessionId: run.sessionId,
          turnId: protocol.turn.id,
          terminalState,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return await finalizeRunWithAssistantMessage({
        run,
        text: message,
        metadata: { terminalState },
        deps: this.getRunCompletionDependencies(),
      });
    }
  }

  private async prepareRun(
    run: Run,
    input: RuntimeKernelNativeRunnerInput,
  ): Promise<void> {
    await this.runEventRecorder.ensureRunStarted(run.status);
    await recordInitialTurnActivity({
      run,
      messages: input.messages,
      prompt: input.input.prompt,
      runEventRecorder: this.runEventRecorder,
    });
    recordOrchestrationActivation(run);
    recordLifecycleStep(run, "CONTEXT_PREPARED");
    await this.runRepo.update(run);
    await this.persistConversationMessages(input.messages, "user");
  }

  private async activateBuildRun(run: Run): Promise<void> {
    if (run.status !== "CREATED") {
      return;
    }
    const previousStatus = run.status;
    run.transition("RUNNING");
    await this.runEventRecorder.recordRunStatusChanged(
      previousStatus,
      run.status,
      RUN_WORKFLOW_STEPS.EXECUTION,
    );
    await this.runRepo.update(run);
  }

  private async prepareBuildWorkspace(
    run: Run,
    input: RunInput,
  ): Promise<Response | null> {
    const bootstrapEvaluation = await evaluateWorkspaceBootstrap(
      run.id,
      input.prompt,
      input.repositoryContext,
      this.workspaceBootstrapper,
      { force: true },
    );
    console.log(
      formatRuntimeDiagnosticLogLine(
        "runtime-kernel/native",
        "workspace-bootstrap-evaluated",
        {
          runId: this.options.runId,
          sessionId: this.options.sessionId,
          status: bootstrapEvaluation.status,
          blocked: bootstrapEvaluation.blocked,
          expectedMiss: bootstrapEvaluation.expectedMiss,
          mode: bootstrapEvaluation.mode ?? "none",
          clonedDuringBootstrap:
            bootstrapEvaluation.clonedDuringBootstrap ?? false,
        },
      ),
    );
    run.metadata.workspaceBootstrap = {
      requested: bootstrapEvaluation.status !== "skipped",
      ready: !bootstrapEvaluation.blocked,
      status: bootstrapEvaluation.status,
      mode: bootstrapEvaluation.mode,
      blocked: bootstrapEvaluation.blocked,
      message: bootstrapEvaluation.message ?? undefined,
      expectedMiss: bootstrapEvaluation.expectedMiss,
      clonedDuringBootstrap: bootstrapEvaluation.clonedDuringBootstrap ?? false,
      recordedAt: new Date().toISOString(),
    };
    await this.runRepo.update(run);

    if (bootstrapEvaluation.blocked) {
      await this.runEventRecorder.recordRunProgress(
        RUN_WORKFLOW_STEPS.PLANNING,
        "Workspace bootstrap",
        describeWorkspaceBootstrapSummary(bootstrapEvaluation),
        "completed",
      );
    }

    if (!bootstrapEvaluation.message) {
      return null;
    }

    return await finalizeRunWithAssistantMessage({
      run,
      text: bootstrapEvaluation.message,
      deps: this.getRunCompletionDependencies(),
    });
  }

  private async getOrCreateRun(input: RunInput): Promise<Run> {
    const existing = await this.runRepo.getById(this.options.runId);
    if (existing) {
      if (existing.sessionId !== this.options.sessionId) {
        throw new Error(
          `runId ${this.options.runId} is already associated with a different session`,
        );
      }
      const isTerminal = RunStateMachine.isTerminalState(existing.status);
      const isIdleCreated =
        existing.status === "CREATED" &&
        (await this.taskRepo.getByRun(this.options.runId)).length === 0;
      if (isTerminal || isIdleCreated) {
        return await resetRecyclableRun({
          runId: this.options.runId,
          sessionId: this.options.sessionId,
          input,
          previousStatus: existing.status,
          existingRun: existing,
          taskRepo: this.taskRepo,
          runRepo: this.runRepo,
          createFreshRun: this.createFreshRun.bind(this),
        });
      }
      ensureManifestMatch(existing.metadata.manifest, createRunManifest(input));
      return existing;
    }
    const run = this.createFreshRun(
      this.options.runId,
      this.options.sessionId,
      input,
    );
    await this.runRepo.create(run);
    return run;
  }

  private createFreshRun(
    runId: string,
    sessionId: string,
    input: RunInput,
  ): Run {
    return new Run(
      runId,
      sessionId,
      "CREATED",
      input.agentType,
      input,
      undefined,
      {
        prompt: input.prompt,
        actorUserId: this.options.userId,
        manifest: createRunManifest(input),
        permissionContext: resolveRunPermissionContext(input),
        orchestrationTelemetry: {
          activeDurationMs: 0,
          wakeupCount: 0,
          resumeCount: 0,
        },
        lifecycleSteps: [
          { step: "RUN_CREATED", recordedAt: new Date().toISOString() },
        ],
      },
    );
  }

  private async isRunCancelled(): Promise<boolean> {
    const current = await this.runRepo.getById(this.options.runId);
    return current?.status === "CANCELLED";
  }

  private getDirectExecutionService(): RuntimeExecutionService {
    if (this.agent instanceof BaseAgent) {
      const service = this.agent.getRuntimeExecutionService();
      if (service) {
        return service;
      }
    }
    throw new Error(
      "[runtime-kernel/native] Direct runtime execution service is required for live kernel tool execution",
    );
  }

  private getRunCompletionDependencies(): RunCompletionDependencies {
    return {
      memoryCoordinator: this.memoryCoordinator,
      persistConversationMessages:
        this.persistConversationMessagesForRun.bind(this),
      runEventRecorder: this.runEventRecorder,
      readCanonicalRunEvents: this.eventRepo.getByRun.bind(this.eventRepo),
      runRepo: this.runRepo,
      safeMemoryOperation: async (operation) => await operation(),
    };
  }

  private async persistConversationMessages(
    messages: CoreMessage[],
    role: "user" | "assistant",
  ): Promise<void> {
    await this.persistConversationMessagesForRun(
      this.options.runId,
      this.options.sessionId,
      messages,
      role,
    );
  }

  private async persistConversationMessagesForRun(
    runId: string,
    sessionId: string,
    messages: CoreMessage[],
    role: "user" | "assistant",
  ): Promise<void> {
    for (const message of messages) {
      if (typeof message.content !== "string" || !message.content.trim()) {
        continue;
      }
      await this.memoryCoordinator.extractAndPersist({
        runId,
        sessionId,
        source: role,
        content: message.content,
        phase: role === "user" ? "planning" : "synthesis",
      });
    }
  }
}

function resolveNativeKernelTerminalState(error: unknown) {
  if (error instanceof RuntimeKernelError && error.code === "approval_denied") {
    return RUN_TERMINAL_STATES.APPROVAL_DENIED;
  }

  if (isModelOrProviderFailure(error)) {
    return RUN_TERMINAL_STATES.FAILED_RUNTIME;
  }

  return RUN_TERMINAL_STATES.FAILED_TOOL;
}

function buildNativeKernelTerminalMessage(
  error: unknown,
  terminalState: (typeof RUN_TERMINAL_STATES)[keyof typeof RUN_TERMINAL_STATES],
): string {
  if (terminalState === RUN_TERMINAL_STATES.FAILED_RUNTIME) {
    return [
      "The selected model/provider failed while deciding the next action.",
      "No sandbox tool failure was reported. Retry the task or switch to a faster, tool-capable model.",
    ].join("\n");
  }

  return error instanceof Error ? error.message : "Runtime execution failed.";
}

function isModelOrProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "LLMTimeoutError" ||
    error.name === "LLMUnusableResponseError" ||
    /\b(llm|model|provider|gateway)\b/i.test(error.name) ||
    /\b(text call timed out|provider request failed|internal error encountered|failed after \d+ attempts?)\b/i.test(
      error.message,
    )
  );
}

class KernelAgenticProvider implements ProviderPort {
  private readonly messages: CoreMessage[];
  private readonly pendingToolCalls: AgenticLoopToolCall[] = [];
  private readonly currentBatchResults: AgenticLoopToolResult[] = [];
  private readonly toolNamesByCallId = new Map<string, string>();
  private readonly lastToolArgsByName = new Map<
    string,
    Record<string, unknown>
  >();
  private consumedToolResults = 0;
  private stepsExecuted = 0;
  private toolExecutionCount = 0;
  private failedToolCount = 0;
  private completedMutatingToolCount = 0;
  private completedReadOnlyToolCount = 0;
  private stopReason: StopReason = "llm_stop";
  private readonly toolLifecycle: AgenticLoopToolLifecycleEvent[] = [];
  private readonly requiresMutation: boolean;

  constructor(
    private readonly options: {
      run: Run;
      input: RunInput;
      messages: CoreMessage[];
      tools: Record<string, CoreTool>;
      llmGateway: ILLMGateway;
      budget: IBudgetManager;
      runRepo: RunRepository;
      runEventRecorder: RunEventRecorder;
      isRunCancelled: () => Promise<boolean>;
    },
  ) {
    this.messages = [...options.messages];
    this.requiresMutation = false;
  }

  async generateNext(input: ProviderCallInput): Promise<ProviderStep> {
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    await this.collectNewToolResults(input.toolResults);
    const queued = this.shiftQueuedToolCall();
    if (queued) return queued;
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    if (await this.options.budget.isOverBudget(this.options.run.id)) {
      this.stopReason = "budget_exceeded";
      return {
        kind: "complete",
        itemId: ItemIdSchema.parse(
          toProtocolId("itm", `${input.run.id}-budget`),
        ),
        output: "The run stopped because its configured budget was exceeded.",
      };
    }
    await this.recordModelStepStarted(input);
    const response = await runWithNativeCancellationPolling(
      this.options.llmGateway.generateText({
        context: {
          runId: this.options.run.id,
          sessionId: this.options.run.sessionId,
          agentType: this.options.run.agentType,
          phase: "task",
          idempotencyKey: `runtime-kernel-native:${this.options.run.id}:step:${this.stepsExecuted + 1}`,
        },
        messages: this.messages,
        system: buildAgenticLoopSystemPrompt({
          workspaceContext: buildAgenticLoopWorkspaceContext({
            repositoryContext: this.options.input.repositoryContext,
            prompt: this.options.input.prompt,
            continuation: this.options.run.metadata.continuation,
            workspaceBootstrap: this.options.run.metadata.workspaceBootstrap,
            gitTaskStrategy: this.options.run.metadata.gitTaskStrategy,
          }),
          finalSynthesisOnly: false,
          requiresMutation: this.requiresMutation,
          completedMutatingToolCount: this.completedMutatingToolCount,
          completedReadOnlyToolCount: this.completedReadOnlyToolCount,
          explicitCiLogRequest: false,
          encounteredCiLogsAuthorizationBoundary: false,
          attemptedCiLogsCliFallback: false,
        }),
        tools: this.options.tools,
        model: this.options.input.modelId,
        providerId: this.options.input.providerId,
        runtimeModelId: this.options.input.runtimeModelId,
        providerTransport: this.options.input.providerTransport,
        providerEndpoint: this.options.input.providerEndpoint,
        temperature: 0.2,
      }),
      this.options.isRunCancelled,
    );
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    this.stepsExecuted += 1;
    await this.recordModelStepCompleted(input);
    const toolCalls = this.repairToolCalls(response.toolCalls ?? []);
    const visibleText = projectVisibleTranscriptText(response.parts ?? []);
    this.messages.push(buildAssistantMessage(visibleText, toolCalls));
    if (toolCalls.length === 0) {
      this.stopReason = "llm_stop";
      return {
        kind: "complete",
        itemId: ItemIdSchema.parse(
          toProtocolId("itm", `${input.run.id}-final`),
        ),
        output: visibleText,
      };
    }
    if (visibleText.trim()) {
      await this.options.runEventRecorder.recordMessageEmitted(
        "assistant",
        visibleText.trim(),
        undefined,
        { phase: "commentary", status: "completed" },
      );
    }
    for (const toolCall of toolCalls) {
      const protocolToolCallId = toProtocolId("toolcall", toolCall.id);
      this.toolNamesByCallId.set(protocolToolCallId, toolCall.toolName);
      this.lastToolArgsByName.set(toolCall.toolName, { ...toolCall.args });
      await this.options.runEventRecorder.recordToolRequested({
        id: protocolToolCallId,
        type: toolCall.toolName,
        input: toolCall.args,
      });
    }
    this.pendingToolCalls.push(...toolCalls);
    return this.shiftQueuedToolCallOrThrow();
  }

  recordToolStarted(toolCall: ToolCallItemContent): void {
    this.toolExecutionCount += 1;
    this.toolLifecycle.push({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      status: "started",
      mutating: isMutatingCodingToolId(toolCall.toolName),
      recordedAt: new Date().toISOString(),
    });
  }

  recordToolCompleted(toolCall: ToolCallItemContent, result: TaskResult): void {
    if (isMutatingCodingToolId(toolCall.toolName)) {
      this.completedMutatingToolCount += 1;
    } else {
      this.completedReadOnlyToolCount += 1;
    }
    this.toolLifecycle.push({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      status: "completed",
      mutating: isMutatingCodingToolId(toolCall.toolName),
      recordedAt: new Date().toISOString(),
      detail: result.output?.content,
    });
  }

  recordToolFailed(
    toolCall: ToolCallItemContent,
    error: string,
    terminal: boolean,
  ): void {
    this.failedToolCount += 1;
    if (terminal) {
      this.stopReason = "tool_error";
    }
    this.toolLifecycle.push({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      status: "failed",
      mutating: isMutatingCodingToolId(toolCall.toolName),
      recordedAt: new Date().toISOString(),
      detail: error,
    });
  }

  recordTerminalError(error: unknown): void {
    this.failedToolCount += 1;
    this.stopReason = "tool_error";
    const detail =
      error instanceof Error ? error.message : "Runtime execution failed.";
    this.toolLifecycle.push({
      toolCallId: "toolcall_runtime_kernel_terminal",
      toolName: "runtime_kernel",
      status: "failed",
      mutating: false,
      recordedAt: new Date().toISOString(),
      detail,
    });
  }

  recordCancelled(): void {
    this.stopReason = "cancelled";
  }

  buildResult() {
    return {
      stopReason: this.stopReason,
      messages: [...this.messages],
      toolExecutionCount: this.toolExecutionCount,
      failedToolCount: this.failedToolCount,
      stepsExecuted: this.stepsExecuted,
      requiresMutation: this.requiresMutation,
      completedMutatingToolCount: this.completedMutatingToolCount,
      completedReadOnlyToolCount: this.completedReadOnlyToolCount,
      toolLifecycle: [...this.toolLifecycle],
    };
  }

  private async recordModelStepStarted(
    input: ProviderCallInput,
  ): Promise<void> {
    await this.options.runEventRecorder.recordRunProgress(
      RUN_WORKFLOW_STEPS.EXECUTION,
      "Thinking",
      "",
      "active",
      {
        displayMode: "visible",
        metadata: {
          owner: "runtime-kernel-native",
          step: this.stepsExecuted + 1,
          turnId: input.turn.id,
          requiresMutation: this.requiresMutation,
        },
      },
    );
    console.log(
      formatRuntimeDiagnosticLogLine(
        "runtime-kernel/native",
        "model-step-started",
        {
          runId: this.options.run.id,
          sessionId: this.options.run.sessionId,
          step: this.stepsExecuted + 1,
          requiresMutation: this.requiresMutation,
        },
      ),
    );
  }

  private async recordModelStepCompleted(
    input: ProviderCallInput,
  ): Promise<void> {
    await this.options.runEventRecorder.recordRunProgress(
      RUN_WORKFLOW_STEPS.EXECUTION,
      "Thinking",
      "",
      "completed",
      {
        displayMode: "debug",
        metadata: {
          owner: "runtime-kernel-native",
          step: this.stepsExecuted,
          turnId: input.turn.id,
        },
      },
    );
    console.log(
      formatRuntimeDiagnosticLogLine(
        "runtime-kernel/native",
        "model-step-completed",
        {
          runId: this.options.run.id,
          sessionId: this.options.run.sessionId,
          step: this.stepsExecuted,
        },
      ),
    );
  }

  private async collectNewToolResults(
    results: readonly ToolResult[],
  ): Promise<void> {
    const nextResults = results.slice(this.consumedToolResults);
    this.consumedToolResults = results.length;
    for (const result of nextResults) {
      this.currentBatchResults.push({
        toolId: result.toolCallId,
        toolName: this.findToolName(result.toolCallId),
        result: result.output,
        error: undefined,
        terminalError: false,
      });
    }
    if (this.pendingToolCalls.length === 0 && this.currentBatchResults.length) {
      this.messages.push(buildToolResultMessage(this.currentBatchResults));
      this.currentBatchResults.length = 0;
    }
  }

  private shiftQueuedToolCall(): ProviderStep | null {
    const toolCall = this.pendingToolCalls.shift();
    if (!toolCall) {
      return null;
    }
    return {
      kind: "tool_call",
      itemId: ItemIdSchema.parse(toProtocolId("itm", toolCall.id)),
      content: ToolCallItemContentSchema.parse({
        toolCallId: toProtocolId("toolcall", toolCall.id),
        toolName: toolCall.toolName,
        input: toolCall.args,
      }),
    };
  }

  private shiftQueuedToolCallOrThrow(): ProviderStep {
    const step = this.shiftQueuedToolCall();
    if (!step) {
      throw new Error("[runtime-kernel/native] Missing queued tool call");
    }
    return step;
  }

  private findToolName(toolCallId: string): string {
    return this.toolNamesByCallId.get(toolCallId) ?? "unknown_tool";
  }

  private repairToolCalls(
    toolCalls: readonly AgenticLoopToolCall[],
  ): AgenticLoopToolCall[] {
    return toolCalls.map((toolCall) => ({
      ...toolCall,
      args: repairToolCallArgs(toolCall, this.lastToolArgsByName),
    }));
  }
}

function repairToolCallArgs(
  toolCall: AgenticLoopToolCall,
  lastToolArgsByName: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const args = isToolArgRecord(toolCall.args) ? { ...toolCall.args } : {};

  switch (toolCall.toolName) {
    case "read_file":
      return repairReadFileArgs(args, lastToolArgsByName.get("read_file"));
    case "list_files":
    case "glob":
    case "grep":
      return repairDirectoryToolArgs(args);
    default:
      return args;
  }
}

function repairReadFileArgs(
  args: Record<string, unknown>,
  previousArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const repaired = { ...args };
  const aliasedPath =
    readStringToolArg(repaired.path) ??
    readStringToolArg(repaired.filePath) ??
    readStringToolArg(repaired.file) ??
    readStringToolArg(repaired.filename);
  if (aliasedPath) {
    repaired.path = aliasedPath;
    return repaired;
  }

  const previousPath = previousArgs
    ? readStringToolArg(previousArgs.path)
    : null;
  const hasWindowContinuation =
    typeof repaired.offset === "number" || typeof repaired.limit === "number";
  if (previousPath && hasWindowContinuation) {
    repaired.path = previousPath;
  }
  return repaired;
}

function repairDirectoryToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (readStringToolArg(args.path)) {
    return args;
  }

  return {
    ...args,
    path: ".",
  };
}

function readStringToolArg(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isToolArgRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class NativeRunCancelledError extends RuntimeKernelError {
  constructor() {
    super("turn_cancelled", "Run was cancelled");
    this.name = "NativeRunCancelledError";
  }
}

async function assertNativeRunNotCancelled(
  isRunCancelled: () => Promise<boolean>,
): Promise<void> {
  if (await isRunCancelled()) {
    throw new NativeRunCancelledError();
  }
}

async function runWithNativeCancellationPolling<T>(
  operation: Promise<T>,
  isRunCancelled: () => Promise<boolean>,
): Promise<T> {
  let stopPolling = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cancellation = new Promise<never>((_, reject) => {
    const schedulePoll = (): void => {
      timeout = setTimeout(() => {
        void pollCancellation().catch(reject);
      }, NATIVE_CANCELLATION_POLL_INTERVAL_MS);
    };

    const pollCancellation = async (): Promise<void> => {
      if (stopPolling) {
        return;
      }
      await assertNativeRunNotCancelled(isRunCancelled);
      if (!stopPolling) {
        schedulePoll();
      }
    };

    schedulePoll();
  });

  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    stopPolling = true;
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class KernelToolWorker implements WorkerProtocolPort {
  constructor(
    private readonly options: {
      runEventRecorder: RunEventRecorder;
      tracker: KernelAgenticProvider;
      isRunCancelled: () => Promise<boolean>;
      toolGateway: RuntimeToolGateway;
    },
  ) {}

  async executeTool(input: {
    runId: ProtocolRun["id"];
    runAttemptId: RunAttemptId;
    turnId: Turn["id"];
    workspace: KernelWorkspaceManifest;
    toolCall: ToolCallItemContent;
    approval: ApprovalResolution | null;
  }): Promise<WorkerToolResult> {
    const toolName = input.toolCall.toolName;
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    if (!isCodingToolId(toolName)) {
      return failed("validation_failed", `Unsupported tool: ${toolName}`);
    }
    this.options.tracker.recordToolStarted(input.toolCall);
    console.log(
      formatRuntimeDiagnosticLogLine("runtime-kernel/native", "tool-started", {
        runId: input.runId,
        toolCallId: input.toolCall.toolCallId,
        toolName,
      }),
    );
    await this.options.runEventRecorder.recordToolStarted({
      id: input.toolCall.toolCallId,
      type: toolName,
    });
    let result: TaskResult;
    try {
      const gatewayResult = await runWithNativeCancellationPolling(
        this.options.toolGateway.execute({
          taskId: input.toolCall.toolCallId,
          toolName,
          toolInput: {
            description: `Execute ${toolName}`,
            ...input.toolCall.input,
          },
          onOutput: async (chunk) => {
            await this.options.runEventRecorder.recordToolOutputAppended(
              { id: input.toolCall.toolCallId, type: toolName },
              {
                stdoutDelta:
                  chunk.source === "stderr" ? undefined : chunk.message,
                stderrDelta:
                  chunk.source === "stderr" ? chunk.message : undefined,
              },
            );
          },
          isCancelled: this.options.isRunCancelled,
        }),
        this.options.isRunCancelled,
      );
      if (gatewayResult.kind === "cancelled") {
        return { kind: "cancelled", reason: "Run cancelled by user." };
      }
      if (gatewayResult.kind === "failed") {
        const message =
          gatewayResult.result.error?.message ?? "Tool execution failed";
        this.options.tracker.recordToolFailed(input.toolCall, message, true);
        await this.options.runEventRecorder.recordToolFailed(
          { id: input.toolCall.toolCallId, type: toolName },
          message,
          0,
        );
        return failed(
          gatewayResult.code === "executor_failed"
            ? "command_failed"
            : gatewayResult.code === "tool_unavailable"
              ? "not_found"
              : gatewayResult.code === "workspace_escape_denied"
                ? "policy_denied"
                : "validation_failed",
          message,
          gatewayResult.retryable,
        );
      }
      result = gatewayResult.result;
    } catch (error) {
      await assertNativeRunNotCancelled(this.options.isRunCancelled);
      const message =
        error instanceof Error ? error.message : "Tool execution failed";
      this.options.tracker.recordToolFailed(input.toolCall, message, true);
      await this.options.runEventRecorder.recordToolFailed(
        { id: input.toolCall.toolCallId, type: toolName },
        message,
        0,
      );
      console.warn(
        formatRuntimeDiagnosticLogLine("runtime-kernel/native", "tool-failed", {
          runId: input.runId,
          toolCallId: input.toolCall.toolCallId,
          toolName,
          errorMessage: message,
        }),
      );
      return failed("command_failed", message);
    }
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    if (result.status === "DONE") {
      this.options.tracker.recordToolCompleted(input.toolCall, result);
      await this.options.runEventRecorder.recordToolCompleted(
        { id: input.toolCall.toolCallId, type: toolName },
        result.output ?? null,
        0,
      );
      console.log(
        formatRuntimeDiagnosticLogLine(
          "runtime-kernel/native",
          "tool-completed",
          {
            runId: input.runId,
            toolCallId: input.toolCall.toolCallId,
            toolName,
          },
        ),
      );
      return {
        kind: "completed",
        output: JsonRecordSchema.parse({
          content: result.output?.content ?? "",
          metadata: result.output?.metadata ?? {},
        }),
      };
    }
    const message = result.error?.message ?? "Tool execution failed";
    this.options.tracker.recordToolFailed(input.toolCall, message, true);
    await this.options.runEventRecorder.recordToolFailed(
      { id: input.toolCall.toolCallId, type: toolName },
      message,
      0,
    );
    console.warn(
      formatRuntimeDiagnosticLogLine("runtime-kernel/native", "tool-failed", {
        runId: input.runId,
        toolCallId: input.toolCall.toolCallId,
        toolName,
        errorMessage: message,
      }),
    );
    return failed("command_failed", message);
  }
}

class NativeApprovalWaitPort implements ApprovalWaitPort {
  constructor(
    private readonly options: {
      env: RunEngineOptions["env"];
      runId: string;
      sessionId: string;
      ownerUserId?: string;
      runRepo: RunRepository;
      runEventRecorder: RunEventRecorder;
      permissionApprovalStore: PermissionApprovalStore;
    },
  ) {}

  async waitForDecision(input: {
    runId: ProtocolRun["id"];
    runAttemptId: RunAttemptId;
    turnId: Turn["id"];
    request: ApprovalRequestedPayload;
  }): Promise<ApprovalResolution> {
    const request = this.toSharedApprovalRequest(input);
    await this.options.permissionApprovalStore.setPendingRequest(
      request,
      this.options.ownerUserId,
    );
    await this.options.runEventRecorder.recordApprovalRequested(request);
    const outcome = await waitForApprovalDecision({
      request,
      env: this.options.env,
      runId: this.options.runId,
      runRepo: this.options.runRepo,
      permissionApprovalStore: this.options.permissionApprovalStore,
    });
    const resolution = this.toApprovalResolution(outcome);
    await ensureApprovalResolvedEventRecorded({
      runEventRecorder: this.options.runEventRecorder,
      requestId: request.requestId,
      decision: mapSharedApprovalDecision(outcome, resolution),
      status: mapSharedApprovalStatus(resolution),
    });
    return resolution;
  }

  private toSharedApprovalRequest(input: {
    turnId: Turn["id"];
    request: ApprovalRequestedPayload;
  }): ApprovalRequest {
    const toolName = readString(input.request.metadata.toolName) ?? "tool";
    const action =
      readString(input.request.metadata.action) ??
      readString(input.request.metadata.toolName) ??
      "execute";
    return {
      requestId: input.request.approvalId,
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      turnId: input.turnId,
      itemId: input.request.itemId ?? undefined,
      origin: "agent",
      category: RISKY_ACTION_CATEGORIES.SHELL_COMMAND,
      title: `Approve ${toolName}`,
      reason: input.request.question,
      actionFingerprint: `kernel:${toolName}:${action}:${input.request.approvalId}`,
      availableDecisions: ["allow_once", "deny", "abort"],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
  }

  private toApprovalResolution(
    outcome: Awaited<ReturnType<typeof waitForApprovalDecision>>,
  ): ApprovalResolution {
    if (outcome.outcome === "approved") {
      return {
        decision: "approved" as ApprovalDecision,
        decidedBy: null,
        reason: null,
      };
    }
    if (outcome.outcome === "cancelled" || outcome.outcome === "aborted") {
      return {
        decision: "cancelled" as ApprovalDecision,
        decidedBy: null,
        reason: `Approval was ${outcome.outcome}.`,
      };
    }
    return {
      decision: "denied" as ApprovalDecision,
      decidedBy: null,
      reason:
        outcome.outcome === "timed_out"
          ? "Approval timed out before a decision was recorded."
          : "Approval request was denied.",
    };
  }
}

class NativePermissionPolicyResolver {
  async resolve(): Promise<PermissionPolicy> {
    const allowLow = ruleSet("allow", "low");
    const askHigh = ruleSet("ask", "high");
    return {
      commands: askHigh,
      paths: allowLow,
      network: askHigh,
      git: askHigh,
      packageManagers: askHigh,
      secrets: ruleSet("deny", "critical"),
      externalServices: askHigh,
      tools: allowLow,
    };
  }
}

function mapSharedApprovalDecision(
  outcome: Awaited<ReturnType<typeof waitForApprovalDecision>>,
  resolution: ApprovalResolution,
): ApprovalRequest["availableDecisions"][number] {
  if (resolution.decision === "approved") {
    return outcome.decision ?? "allow_once";
  }
  return resolution.decision === "cancelled" ? "abort" : "deny";
}

function mapSharedApprovalStatus(
  resolution: ApprovalResolution,
): "approved" | "denied" | "aborted" {
  if (resolution.decision === "approved") {
    return "approved";
  }
  return resolution.decision === "cancelled" ? "aborted" : "denied";
}

function ruleSet(
  defaultEffect: RuleSetPolicy["defaultEffect"],
  defaultRiskLevel: RuleSetPolicy["defaultRiskLevel"],
  rules: RuleSetPolicy["rules"] = [],
): RuleSetPolicy {
  return { defaultEffect, defaultRiskLevel, rules };
}

function buildProtocolEnvelope(input: {
  runId: string;
  sessionId: string;
  userId?: string;
  input: RunInput;
  turnId: Turn["id"];
  timestamp: string;
  canonicalRunAttemptId?: string;
  canonicalThreadId?: string;
  canonicalWorkspaceId?: string;
}): {
  run: ProtocolRun;
  turn: Turn;
  runAttemptId: RunAttemptId;
  manifest: KernelWorkspaceManifest;
} {
  const workspaceId = toProtocolId(
    "wrk",
    input.canonicalWorkspaceId ?? input.runId,
  );
  const threadId = input.canonicalThreadId
    ? ThreadIdSchema.parse(input.canonicalThreadId)
    : toProtocolId("thr", input.sessionId);
  const runAttemptId = input.canonicalRunAttemptId
    ? RunAttemptIdSchema.parse(input.canonicalRunAttemptId)
    : RunAttemptIdSchema.parse(toProtocolId("attempt", input.runId));
  const workerId = WorkerIdSchema.parse(toProtocolId("worker", input.runId));
  const permissionProfileId = PermissionProfileIdSchema.parse(
    toProtocolId("perm", input.runId),
  );
  const run = RunSchema.parse({
    id: input.runId,
    threadId,
    userId: toProtocolId("usr", input.userId ?? input.sessionId),
    workspaceId,
    status: "running",
    mode: input.input.mode === "plan" ? "plan" : "auto_edit",
    providerId: normalizeSlug(input.input.providerId, "default-provider", 64),
    modelId: normalizeModelId(
      input.input.runtimeModelId ?? input.input.modelId,
    ),
    workerId,
    permissionProfileId,
    startedAt: input.timestamp,
    completedAt: null,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    lastEventSequence: 0,
  });
  const manifest = {
    runId: run.id,
    workspaceId: run.workspaceId,
    repoOwner: normalizeRepoPart(input.input.repositoryContext?.owner, "local"),
    repoName: normalizeRepoPart(
      input.input.repositoryContext?.repo,
      "workspace",
    ),
    repoUrl: buildRepoUrl(input.input.repositoryContext),
    baseBranch: input.input.repositoryContext?.branch ?? "dev",
    workingBranch: `run/${input.runId}`,
    baseSha: DEFAULT_SHA,
    headSha: DEFAULT_SHA,
    executionLocation: "cloud_sandbox",
    workerId,
    filesystemRoot: `/home/sandbox/runs/${input.runId}`,
    artifactNamespace: `runtime-kernel/${input.runId}`,
    permissionProfileId,
    state: "ready",
    lastError: null,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  } satisfies KernelWorkspaceManifest;
  return {
    run,
    turn: TurnSchema.parse({
      id: input.turnId,
      threadId,
      runId: input.runId,
      parentTurnId: null,
      status: "queued",
      startedAt: null,
      completedAt: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      lastEventSequence: 0,
    }),
    runAttemptId,
    manifest,
  };
}

function createWorkspaceManifestRepository(manifest: KernelWorkspaceManifest) {
  return {
    create: async () => manifest,
    update: async () => manifest,
    getByWorkspaceId: async () => manifest,
    getLatestByRunId: async () => manifest,
  };
}

function createSnapshotPort(
  manifest: KernelWorkspaceManifest,
): RuntimeGitSnapshotPort {
  return {
    captureSnapshot: async () => ({
      runId: manifest.runId,
      filesystemRoot: manifest.filesystemRoot,
      headSha: manifest.headSha,
      treeId: manifest.headSha,
    }),
    getSnapshotDiff: async () => ({ files: [], patch: "" }),
  };
}

function createTurnArtifactPort(): RuntimeTurnArtifactPort {
  return {
    putSnapshot: async ({ snapshot }) => ({
      phase: snapshot.phase,
      headSha: snapshot.headSha,
    }),
    putTurnDiff: async ({ diff }) => ({
      files: diff.files,
      patch: diff.patch,
    }),
  };
}

function createContextAssembly(input: RunInput): ContextAssemblyPort {
  return {
    assemble: async () => ({
      instructions: input.prompt,
      metadata: JsonRecordSchema.parse({
        repositoryContext: input.repositoryContext ?? {},
      }),
    }),
  };
}

function requireAiService(dependencies: RunEngineDependencies) {
  if (!dependencies.aiService) {
    throw new Error(
      "[runtime-kernel/native] LLMRuntimeAIService is required when llmGateway is not injected",
    );
  }
  return dependencies.aiService;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function failed(
  code: "validation_failed" | "command_failed" | "not_found" | "policy_denied",
  message: string,
  retryable = false,
): WorkerToolResult {
  return {
    kind: "failed",
    failure: {
      code,
      message,
      details: null,
      retryable,
      correlationId: null,
    },
  };
}

function normalizeModelId(value: string | undefined): string {
  return (value ?? "default-model")
    .replace(/[^A-Za-z0-9._:/+-]+/g, "-")
    .slice(0, 192);
}

function normalizeRepoPart(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = (value ?? fallback).replace(/[^A-Za-z0-9._-]+/g, "-");
  return normalized || fallback;
}

function buildRepoUrl(context: RunInput["repositoryContext"]): string {
  if (
    context?.baseUrl?.startsWith("http://") ||
    context?.baseUrl?.startsWith("https://")
  ) {
    return context.baseUrl;
  }
  const owner = normalizeRepoPart(context?.owner, "local");
  const repo = normalizeRepoPart(context?.repo, "workspace");
  return `https://github.com/${owner}/${repo}`;
}

function normalizeSlug(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const normalized = (value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

function toProtocolId(prefix: string, value: string): string {
  if (new RegExp(`^${prefix}_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$`).test(value)) {
    return value;
  }
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  const suffix = sanitized.length >= 6 ? sanitized : `${sanitized}000000`;
  return `${prefix}_${suffix}`;
}
