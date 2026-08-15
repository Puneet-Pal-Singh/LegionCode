import type { CoreMessage, CoreTool } from "ai";
import {
  ContextBudgetSnapshotSchema,
  ItemIdSchema,
  JsonRecordSchema,
  PermissionProfileIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  ThreadIdSchema,
  ToolCallItemContentSchema,
  TurnSchema,
  UsageCostSnapshotSchema,
  WorkerIdSchema,
  type ApprovalDecision,
  type ApprovalRequestedPayload,
  type Run as ProtocolRun,
  type RunAttemptId,
  type ThreadId,
  type ToolCallItemContent,
  type Turn,
  type UsageCostSnapshot,
  projectVisibleTranscriptText,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type {
  ApprovalResolution,
  ApprovalWaitPort,
  ContextAssemblyPort,
  ContextCompactionPort,
  ProviderCallInput,
  ProviderPort,
  ProviderStep,
  RuntimeGitSnapshotPort,
  RuntimeKernelDependencies,
  RuntimeLifecycleEventStore,
  RuntimeHookOrchestrationPort,
  RuntimeTurnArtifactPort,
  ToolResult,
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import { RuntimeKernel, RuntimeKernelError } from "@repo/runtime-kernel";
import {
  RISKY_ACTION_CATEGORIES,
  ReasoningEffortSchema,
  RUN_WORKFLOW_STEPS,
  type ApprovalRequest,
  RUN_TERMINAL_STATES,
} from "@repo/shared-types";
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
import {
  LLMGateway,
  type ILLMGateway,
  type LLMTextResponse,
} from "../llm/index.js";
import { PlannerService } from "../planner/index.js";
import {
  BudgetManager,
  CostLedger,
  CostTracker,
  PricingRegistry,
  PricingResolver,
  registerRuntimeModelPricing,
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
import {
  getNativeToolCallSafetyLimit,
  shouldForceNativeFinalSynthesis,
} from "./NativeProviderStepBudget.js";
import { shouldRetryNativeFinalOnlyResponse } from "./NativeProviderFinalRecoveryPolicy.js";
import { buildNativeProviderMessages } from "./NativeProviderFinalRecoveryMessages.js";
import {
  buildNativeProviderStructuredFinal,
  NativeProviderFinalAnswerSchema,
} from "./NativeProviderStructuredFinal.js";
import { buildAgenticLoopWorkspaceContext } from "./RunContinuationContext.js";
import { createRunManifest, ensureManifestMatch } from "./RunManifestPolicy.js";
import {
  createStreamResponse,
  finalizeRunWithAssistantMessage,
  type RunCompletionDependencies,
} from "./RunCompletionPolicy.js";
import { createRuntimeFinalText } from "./FinalAssistantMessageService.js";
import {
  recordLifecycleStep,
  recordOrchestrationActivation,
  recordPhaseSelectionSnapshot,
  recordTurnModeDecision,
} from "./RunMetadataPolicy.js";
import { recordInitialTurnActivity } from "./RunInitialActivityPolicy.js";
import { isTerminalToolFailure } from "./ToolFailureTerminalPolicy.js";
import {
  buildPlanModeResponse,
  persistPlanArtifact,
} from "./RunPlanModePolicy.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import { NativePermissionPolicyResolver } from "./NativePermissionPolicyResolver.js";
import { describeWorkspaceBootstrapSummary } from "./RunWorkspaceBootstrapSummaryPolicy.js";
import {
  buildNativeKernelTerminalMessage,
  resolveNativeKernelTerminalState,
} from "./NativeTerminalFailurePresentation.js";
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
import { requirePersistedPermissionContext } from "./RuntimePermissionContext.js";
import { formatRuntimeDiagnosticLogLine } from "../lib/RuntimeDiagnosticLog.js";
import { createCloudSandboxRunCapabilityManifest } from "../capabilities/RuntimeCapabilityManifest.js";
import { RuntimeToolGateway } from "./RuntimeToolGateway.js";
import { RuntimeWorkspaceScope } from "./RuntimeWorkspaceScope.js";
import { RuntimeKernelProviderTranscript } from "./RuntimeKernelProviderTranscript.js";
import { ProviderToolCallIdentityMap } from "./ProviderToolCallIdentityMap.js";
import {
  buildProviderContextMessages,
  estimateConversationTokens,
  summarizeConversationForCompaction,
} from "./NativeProviderContextMessages.js";
import { runWithProviderRateLimitRecovery } from "./NativeProviderRateLimitRecovery.js";
import { resolveModelCommentary } from "./NativeProviderCommentary.js";

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
  hookOrchestration?: RuntimeHookOrchestrationPort;
  turnId: Turn["id"];
  runAttemptId?: string;
  threadId?: string;
  workspaceId?: string;
  workspace: {
    filesystemRoot: string;
    workingBranch: string;
    startTreeId: string;
    artifactNamespace: string;
  };
  now?: () => string;
}

type NativeProviderCallContext = {
  runId: string;
  sessionId: string;
  agentType: string;
  phase: "task" | "synthesis";
  idempotencyKey: string;
};

export class RuntimeKernelNativeRunner {
  private activeTurn: {
    readonly turnId: Turn["id"];
    readonly abortController: AbortController;
    interruptReason: string | null;
    kernel: RuntimeKernel | null;
    kernelStarted: boolean;
  } | null = null;
  private pendingInterruptReason: string | null = null;
  private readonly interruptedTurns = new Set<Turn["id"]>();
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
  private readonly gitSnapshots?: RuntimeGitSnapshotPort;
  private readonly prepareMutationCapture?: () => Promise<void>;

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
    this.gitSnapshots = dependencies.gitSnapshots;
    this.prepareMutationCapture = dependencies.prepareMutationCapture;
    this.memoryCoordinator =
      dependencies.memoryCoordinator ??
      new MemoryCoordinator({
        repository: new MemoryRepository({ ctx }),
        sessionMemoryClient: dependencies.sessionMemoryClient,
      });
  }

  async execute(input: RuntimeKernelNativeRunnerInput): Promise<Response> {
    this.beginActiveTurn(input.turnId);
    try {
      registerRuntimeModelPricing(this.pricingRegistry, {
        providerId: input.input.providerId,
        modelId: input.input.modelId,
        runtimeModelId: input.input.runtimeModelId,
        pricing: input.input.metadata?.pricing,
      });
      return await this.executeActiveTurn(input);
    } finally {
      this.endActiveTurn(input.turnId);
    }
  }

  private async executeActiveTurn(
    input: RuntimeKernelNativeRunnerInput,
  ): Promise<Response> {
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
    await this.prepareMutationCapture?.();
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
      workspace: input.workspace,
    });
    const maxSteps = getAgenticLoopMaxSteps(input.input.metadata);
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
      maxSteps,
    });
    const capabilityManifest = createCloudSandboxRunCapabilityManifest({
      runId: protocol.run.id,
      workspaceRoot: protocol.manifest.filesystemRoot,
      artifactRoot: `${protocol.manifest.filesystemRoot}/artifacts`,
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
          threadId: protocol.turn.threadId,
          turnId: protocol.turn.id,
          runAttemptId: protocol.runAttemptId,
          workspaceId: protocol.manifest.workspaceId,
          root: protocol.manifest.filesystemRoot,
        }),
      }),
    });
    const kernel = new RuntimeKernel({
      lifecycleEvents: input.lifecycleEvents,
      workspaceManifests: createWorkspaceManifestRepository(protocol.manifest),
      gitSnapshots:
        this.gitSnapshots ?? createUnavailableSnapshotPort(protocol.manifest),
      turnArtifacts: createTurnArtifactPort(),
      contextAssembly: createContextAssembly(
        input.input,
        input.messages,
        runtimeTools,
      ),
      contextCompaction: createContextCompaction(input.input, input.messages),
      provider,
      worker,
      toolAuthorization: new RegistryToolAuthorization(
        new NativePermissionPolicyResolver(
          requirePersistedPermissionContext(run).state.productMode,
        ),
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
      hooks: input.hookOrchestration,
      producerId: "runtime-kernel-native",
      maxToolCalls: getNativeToolCallSafetyLimit(maxSteps),
      clock: { now },
      signal: this.activeTurn?.abortController.signal,
    });
    this.resolveActiveKernel(protocol.turn.id, kernel);
    const result = await this.startKernelTurn(kernel, protocol, run, provider);
    if (this.interruptedTurns.delete(protocol.turn.id)) {
      return createStreamResponse("");
    }
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
    const modelParts =
      finalMessage.source === "model" ? finalMessage.parts : undefined;
    const response = await finalizeRunWithAssistantMessage({
      run,
      runtimeFinal:
        finalMessage.source === "runtime"
          ? createRuntimeFinalText(finalMessage.text || result.output)
          : undefined,
      modelParts,
      metadata: {
        ...(finalMessage.metadata ?? {}),
        terminalState: RUN_TERMINAL_STATES.COMPLETED,
      },
      deps: this.getRunCompletionDependencies(),
    });
    return response;
  }

  async interrupt(turnId: Turn["id"], reason: string): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.turnId !== turnId) {
      this.pendingInterruptReason ??= reason;
      return;
    }

    activeTurn.interruptReason = reason;
    activeTurn.abortController.abort(new DOMException(reason, "AbortError"));
    this.interruptedTurns.add(turnId);

    if (activeTurn.kernel?.isTurnReady(turnId)) {
      const kernel = activeTurn.kernel;
      await kernel.interruptTurn(turnId, reason);
    } else if (activeTurn.kernel) {
      activeTurn.kernel.requestInterruptBeforeStart(turnId, reason);
    }
  }

  async compact(turnId: Turn["id"]): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.turnId !== turnId || !activeTurn.kernel) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} is not ready for context compaction`,
      );
    }
    await activeTurn.kernel.compactTurn(turnId, "manual");
  }

  async resolveApproval(
    turnId: Turn["id"],
    approvalId: ApprovalRequestedPayload["approvalId"],
    resolution: ApprovalResolution,
  ): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.turnId !== turnId) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} is not owned by this runtime runner`,
      );
    }
    const kernel = activeTurn.kernel;
    if (!kernel) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${turnId} did not reach the runtime kernel`,
      );
    }
    await kernel.resolveApproval(turnId, approvalId, resolution);
  }

  private beginActiveTurn(turnId: Turn["id"]): void {
    this.activeTurn = {
      turnId,
      abortController: new AbortController(),
      interruptReason: this.pendingInterruptReason,
      kernel: null,
      kernelStarted: false,
    };
    if (this.pendingInterruptReason !== null) {
      this.activeTurn.abortController.abort(
        new DOMException(this.pendingInterruptReason, "AbortError"),
      );
      this.pendingInterruptReason = null;
      this.interruptedTurns.add(turnId);
    }
  }

  private resolveActiveKernel(turnId: Turn["id"], kernel: RuntimeKernel): void {
    if (this.activeTurn?.turnId === turnId) {
      this.activeTurn.kernel = kernel;
      if (
        this.activeTurn.interruptReason !== null &&
        !this.activeTurn.kernelStarted
      ) {
        kernel.requestInterruptBeforeStart(
          turnId,
          this.activeTurn.interruptReason,
        );
      }
    }
  }

  private endActiveTurn(turnId: Turn["id"]): void {
    if (this.activeTurn?.turnId === turnId) {
      this.activeTurn = null;
    }
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
      runtimeFinal: createRuntimeFinalText(buildPlanModeResponse(planArtifact)),
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
      const activeTurn = this.activeTurn;
      if (activeTurn?.turnId === protocol.turn.id) {
        activeTurn.kernelStarted = false;
        if (activeTurn.interruptReason !== null) {
          kernel.requestInterruptBeforeStart(
            protocol.turn.id,
            activeTurn.interruptReason,
          );
        }
      }
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
      const result = await kernel.startTurn(protocol);
      if (this.activeTurn?.turnId === protocol.turn.id) {
        this.activeTurn.kernelStarted = true;
      }
      return result;
    } catch (error) {
      if (this.interruptedTurns.has(protocol.turn.id)) {
        return createStreamResponse("");
      }
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
          cause: describeRuntimeErrorCause(error),
        }),
      );
      await finalizeRunWithAssistantMessage({
        run,
        runtimeFinal: createRuntimeFinalText(message),
        metadata: { terminalState },
        deps: this.getRunCompletionDependencies(),
      });
      // The lifecycle terminal is the canonical failed-turn renderer. Do not
      // stream a second assistant bubble above the failed workflow surface.
      return createStreamResponse("");
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
      runtimeFinal: createRuntimeFinalText(bootstrapEvaluation.message),
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

function describeRuntimeErrorCause(error: unknown): string | null {
  if (
    !(error instanceof RuntimeKernelError) ||
    error.causeError === undefined
  ) {
    return null;
  }
  const cause = error.causeError;
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : "non-error runtime cause";
}

class KernelAgenticProvider implements ProviderPort {
  private readonly messages: CoreMessage[];
  private readonly pendingToolCalls: AgenticLoopToolCall[] = [];
  private pendingUsage: UsageCostSnapshot | null = null;
  private cumulativeTokens = 0;
  private cumulativeCost = 0;
  private pendingCommentary: string | null = null;
  private readonly currentBatchResults: AgenticLoopToolResult[] = [];
  private readonly toolNamesByCallId = new Map<string, string>();
  private readonly providerToolCallIdentities =
    new ProviderToolCallIdentityMap();
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
  private readonly transcript = new RuntimeKernelProviderTranscript();
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
      maxSteps: number;
    },
  ) {
    this.messages = [...options.messages];
    this.requiresMutation = false;
  }

  async generateNext(input: ProviderCallInput): Promise<ProviderStep> {
    assertSignalNotAborted(input.signal);
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
    let finalOnlyRecoveryAttempts = shouldForceNativeFinalSynthesis(
      this.stepsExecuted,
      this.options.maxSteps,
    )
      ? 1
      : 0;
    let responseParts: LLMTextResponse["parts"];
    let responseUsage: LLMTextResponse["usage"] | null = null;
    let toolCalls: AgenticLoopToolCall[];
    let visibleText: string;

    do {
      await this.recordModelStepStarted(input);
      const finalRecovery = finalOnlyRecoveryAttempts > 0;
      const context = {
        runId: this.options.run.id,
        sessionId: this.options.run.sessionId,
        agentType: this.options.run.agentType,
        phase: finalRecovery ? ("synthesis" as const) : ("task" as const),
        idempotencyKey: `runtime-kernel-native:${this.options.run.id}:turn:${input.turn.id}:step:${this.stepsExecuted + 1}:${finalRecovery ? `final-${finalOnlyRecoveryAttempts}` : "task"}`,
      };
      const contextMessages = buildProviderContextMessages({
        messages: this.messages,
        compactedContext: readContextString(
          input.context.metadata,
          "compactedContext",
        ),
      });
      const messages = buildNativeProviderMessages(
        contextMessages,
        finalOnlyRecoveryAttempts,
      );

      if (finalRecovery) {
        const recovered = await this.requestWithRateLimitRecovery(
          input,
          context,
          (attemptContext) =>
            this.options.llmGateway.generateStructured({
              context: attemptContext,
              messages,
              schema: NativeProviderFinalAnswerSchema,
              model: this.options.input.modelId,
              providerId: this.options.input.providerId,
              runtimeModelId: this.options.input.runtimeModelId,
              providerTransport: this.options.input.providerTransport,
              providerEndpoint: this.options.input.providerEndpoint,
              temperature: 0,
            }),
        );
        const response = recovered;
        responseUsage = response.usage;
        responseParts = [
          buildNativeProviderStructuredFinal({
            runId: this.options.run.id,
            turnId: input.turn.id,
            finalAnswer: response.object.finalAnswer,
            sequence: 0,
          }),
        ];
        toolCalls = [];
      } else {
        const response = await this.requestWithRateLimitRecovery(
          input,
          context,
          (attemptContext) =>
            this.options.llmGateway.generateText({
              context: attemptContext,
              messages,
              system: buildAgenticLoopSystemPrompt({
                workspaceContext: buildAgenticLoopWorkspaceContext({
                  repositoryContext:
                    readContextRecord(
                      input.context.metadata,
                      "repositoryContext",
                    ) ?? this.options.input.repositoryContext,
                  prompt: [
                    input.context.instructions,
                    readContextString(
                      input.context.metadata,
                      "compactedContext",
                    ),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  continuation: this.options.run.metadata.continuation,
                  workspaceBootstrap:
                    this.options.run.metadata.workspaceBootstrap,
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
              reasoningEffort: parseReasoningEffort(
                this.options.input.metadata?.reasoningEffort,
              ),
              signal: input.signal,
            }),
        );
        responseUsage = response.usage;
        toolCalls = this.repairToolCalls(response.toolCalls ?? []);
        responseParts = response.parts ?? [];
      }
      await assertNativeRunNotCancelled(this.options.isRunCancelled);
      assertSignalNotAborted(input.signal);
      this.stepsExecuted += 1;
      await this.recordModelStepCompleted(input);
      visibleText = projectVisibleTranscriptText(responseParts);

      if (
        shouldRetryNativeFinalOnlyResponse({
          recoveryAttemptCount: finalOnlyRecoveryAttempts,
          toolCallCount: toolCalls.length,
          responseParts,
        })
      ) {
        finalOnlyRecoveryAttempts += 1;
        continue;
      }

      break;
    } while (true);

    if (!responseUsage) {
      throw new Error(
        "[runtime-kernel/native] Provider returned no usage record",
      );
    }
    this.messages.push(buildAssistantMessage(visibleText, toolCalls));
    if (toolCalls.length === 0) {
      const terminal = this.transcript.complete(responseParts);
      this.stopReason = "llm_stop";
      return {
        kind: "complete",
        itemId: ItemIdSchema.parse(
          toProtocolId("itm", `${input.run.id}-final`),
        ),
        output: terminal.text,
        usage: toUsageSnapshot(
          responseUsage,
          input,
          this.addUsage(responseUsage),
        ),
      };
    }
    const commentary = resolveModelCommentary(visibleText);
    if (commentary) {
      await this.options.runEventRecorder.recordMessageEmitted(
        "assistant",
        commentary,
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
    this.pendingCommentary = commentary;
    this.pendingUsage = toUsageSnapshot(
      responseUsage,
      input,
      this.addUsage(responseUsage),
    );
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
      finalTranscriptParts: this.transcript.readFinalParts(),
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

  private async requestWithRateLimitRecovery<T>(
    input: ProviderCallInput,
    context: NativeProviderCallContext,
    operation: (context: NativeProviderCallContext) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await runWithProviderRateLimitRecovery(
        (retryCount) =>
          runWithNativeCancellationPolling(
            operation({
              ...context,
              idempotencyKey:
                retryCount === 0
                  ? context.idempotencyKey
                  : `${context.idempotencyKey}:rate-limit-retry:${retryCount}`,
            }),
            this.options.isRunCancelled,
          ),
        {
          signal: input.signal,
          onRateLimit: async (delayMs, retryCount) => {
            const seconds = Math.max(1, Math.ceil(delayMs / 1_000));
            await this.options.runEventRecorder.recordRunProgress(
              RUN_WORKFLOW_STEPS.EXECUTION,
              "Provider cooldown",
              `The model provider asked LegionCode to retry in ${seconds}s. Waiting before the next model request.`,
              "active",
              {
                displayMode: "visible",
                metadata: {
                  owner: "runtime-kernel-native",
                  retryCount,
                  retryAfterSeconds: seconds,
                  turnId: input.turn.id,
                },
              },
            );
          },
        },
      );
      if (result.retryCount > 0) {
        await this.options.runEventRecorder.recordRunProgress(
          RUN_WORKFLOW_STEPS.EXECUTION,
          "Provider cooldown",
          "The provider cooldown ended and model execution resumed.",
          "completed",
          {
            displayMode: "debug",
            metadata: {
              owner: "runtime-kernel-native",
              retryCount: result.retryCount,
              turnId: input.turn.id,
            },
          },
        );
      }
      return result.value;
    } catch (error) {
      assertSignalNotAborted(input.signal);
      throw error;
    }
  }

  private async collectNewToolResults(
    results: readonly ToolResult[],
  ): Promise<void> {
    const nextResults = results.slice(this.consumedToolResults);
    this.consumedToolResults = results.length;
    for (const result of nextResults) {
      this.currentBatchResults.push({
        toolId: this.findProviderToolCallId(result.toolCallId),
        toolName: this.findToolName(result.toolCallId),
        result: result.output,
        error: result.failure?.message,
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
    const commentary = this.pendingCommentary;
    this.pendingCommentary = null;
    const usage = this.pendingUsage;
    this.pendingUsage = null;
    const protocolToolCallId = toProtocolId("toolcall", toolCall.id);
    this.providerToolCallIdentities.register(protocolToolCallId, toolCall.id);
    return {
      kind: "tool_call",
      itemId: ItemIdSchema.parse(toProtocolId("itm", toolCall.id)),
      content: ToolCallItemContentSchema.parse({
        toolCallId: protocolToolCallId,
        toolName: toolCall.toolName,
        input: toolCall.args,
      }),
      ...(commentary ? { commentary } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private addUsage(usage: LLMTextResponse["usage"]): {
    cumulativeTokens: number;
    cumulativeCost: number;
  } {
    this.cumulativeTokens += usage.totalTokens;
    this.cumulativeCost += usage.cost ?? 0;
    return {
      cumulativeTokens: this.cumulativeTokens,
      cumulativeCost: this.cumulativeCost,
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

  private findProviderToolCallId(protocolToolCallId: string): string {
    return this.providerToolCallIdentities.toProviderId(protocolToolCallId);
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

function parseReasoningEffort(value: unknown) {
  const parsed = ReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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

function assertSignalNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
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
    signal?: AbortSignal;
  }): Promise<WorkerToolResult> {
    const toolName = input.toolCall.toolName;
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    if (!isCodingToolId(toolName)) {
      return failed(
        "validation_failed",
        `Unsupported tool: ${toolName}`,
        false,
        "terminal",
      );
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
            assertSignalNotAborted(input.signal);
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
          signal: input.signal,
        }),
        this.options.isRunCancelled,
      );
      if (gatewayResult.kind === "cancelled") {
        return { kind: "cancelled", reason: "Run cancelled by user." };
      }
      assertSignalNotAborted(input.signal);
      if (gatewayResult.kind === "failed") {
        const message =
          gatewayResult.result.error?.message ?? "Tool execution failed";
        const gatewayFailureCode =
          gatewayResult.code === "executor_failed"
            ? "command_failed"
            : gatewayResult.code === "tool_unavailable"
              ? "not_found"
              : gatewayResult.code === "workspace_escape_denied"
                ? "policy_denied"
                : "validation_failed";
        const failureCode = gatewayResult.failure?.code ?? gatewayFailureCode;
        const disposition = toolFailureDisposition(
          toolName,
          message,
          undefined,
          failureCode,
        );
        this.options.tracker.recordToolFailed(
          input.toolCall,
          message,
          disposition === "terminal",
        );
        await this.options.runEventRecorder.recordToolFailed(
          { id: input.toolCall.toolCallId, type: toolName },
          message,
          0,
        );
        if (gatewayResult.failure) {
          return {
            kind: "failed",
            failure: gatewayResult.failure,
            disposition:
              gatewayResult.failure.code === "worker_unavailable"
                ? "terminal"
                : disposition,
          };
        }
        return failed(
          gatewayFailureCode,
          message,
          gatewayResult.retryable,
          disposition,
        );
      }
      result = gatewayResult.result;
    } catch (error) {
      await assertNativeRunNotCancelled(this.options.isRunCancelled);
      const message =
        error instanceof Error ? error.message : "Tool execution failed";
      const disposition = toolFailureDisposition(toolName, message);
      this.options.tracker.recordToolFailed(
        input.toolCall,
        message,
        disposition === "terminal",
      );
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
      return failed("command_failed", message, false, disposition);
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
    const disposition = toolFailureDisposition(
      toolName,
      message,
      result.output?.metadata,
    );
    this.options.tracker.recordToolFailed(
      input.toolCall,
      message,
      disposition === "terminal",
    );
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
    return failed("command_failed", message, false, disposition);
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
  workspace: RuntimeKernelNativeRunnerInput["workspace"];
}): {
  run: ProtocolRun;
  turn: Turn;
  runAttemptId: RunAttemptId;
  manifest: KernelWorkspaceManifest;
} {
  const workspaceId = workspaceIdFromExternalId(
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
    workingBranch: input.workspace.workingBranch,
    baseSha: input.workspace.startTreeId,
    headSha: input.workspace.startTreeId,
    executionLocation: "cloud_sandbox",
    workerId,
    filesystemRoot: input.workspace.filesystemRoot,
    artifactNamespace: input.workspace.artifactNamespace,
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

function createUnavailableSnapshotPort(
  manifest: KernelWorkspaceManifest,
): RuntimeGitSnapshotPort {
  return {
    captureSnapshot: async () => ({
      runId: manifest.runId,
      filesystemRoot: manifest.filesystemRoot,
      headSha: manifest.headSha,
      treeId: manifest.headSha,
    }),
    getSnapshotDiff: async () => {
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "The runtime Git snapshot port is not configured",
      );
    },
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

function createContextAssembly(
  input: RunInput,
  messages: readonly CoreMessage[],
  tools: Readonly<Record<string, CoreTool>>,
): ContextAssemblyPort {
  return {
    assemble: async () => {
      const repositoryText = JSON.stringify(input.repositoryContext ?? {});
      const conversationTokens = estimateConversationTokens(messages);
      const repositoryContextTokens = Math.ceil(repositoryText.length / 4);
      const systemTokens = Math.ceil(
        buildAgenticLoopSystemPrompt({
          finalSynthesisOnly: false,
          requiresMutation: false,
          completedMutatingToolCount: 0,
          completedReadOnlyToolCount: 0,
          explicitCiLogRequest: false,
          encounteredCiLogsAuthorizationBoundary: false,
          attemptedCiLogsCliFallback: false,
        }).length / 4,
      );
      const toolDefinitionTokens = Math.ceil(JSON.stringify(tools).length / 4);
      const attachmentTokens = null;
      const contextWindowLimit = readPositiveInteger(
        input.metadata?.contextWindowTokens,
      );
      if (!contextWindowLimit) {
        return {
          instructions: input.prompt,
          metadata: JsonRecordSchema.parse({
            repositoryContext: input.repositoryContext ?? {},
          }),
        };
      }
      const reservedOutputTokens = Math.min(
        8_192,
        Math.floor(contextWindowLimit * 0.1),
      );
      const safetyReserveTokens = Math.min(
        4_096,
        Math.floor(contextWindowLimit * 0.05),
      );
      const effectiveInputBudget = Math.max(
        1,
        contextWindowLimit - reservedOutputTokens - safetyReserveTokens,
      );
      const tokensUsed =
        systemTokens +
        conversationTokens +
        toolDefinitionTokens +
        repositoryContextTokens;
      const snapshot = ContextBudgetSnapshotSchema.parse({
        providerId: input.providerId ?? "unknown",
        modelId: input.runtimeModelId ?? input.modelId ?? "unknown",
        contextWindowLimit,
        systemTokens,
        conversationTokens,
        toolDefinitionTokens,
        attachmentTokens,
        repositoryContextTokens,
        reservedOutputTokens,
        safetyReserveTokens,
        effectiveInputBudget,
        tokensUsed,
        tokensRemaining: Math.max(0, effectiveInputBudget - tokensUsed),
        utilizationPercent: Math.min(
          100,
          (tokensUsed / effectiveInputBudget) * 100,
        ),
        warningThresholdPercent: 70,
        automaticCompactionThresholdPercent: 90,
        measurementSource: "estimate",
      });
      return {
        instructions: input.prompt,
        metadata: JsonRecordSchema.parse({
          repositoryContext: input.repositoryContext ?? {},
        }),
        budgetSnapshot: snapshot,
      };
    },
  };
}

function createContextCompaction(
  input: RunInput,
  messages: readonly CoreMessage[],
): ContextCompactionPort {
  return {
    compact: async ({ context, turn }) => {
      const summary = summarizeConversationForCompaction(
        messages,
        input.prompt,
      );
      const budget = context.budgetSnapshot;
      const compactedTokens = Math.max(
        1,
        Math.ceil(
          (summary.length + JSON.stringify(context.metadata).length) / 4,
        ),
      );
      const compactedBudget = budget
        ? ContextBudgetSnapshotSchema.parse({
            ...budget,
            conversationTokens: compactedTokens,
            repositoryContextTokens: null,
            tokensUsed: Math.min(budget.effectiveInputBudget, compactedTokens),
            tokensRemaining: Math.max(
              0,
              budget.effectiveInputBudget - compactedTokens,
            ),
            utilizationPercent: Math.min(
              100,
              (compactedTokens / budget.effectiveInputBudget) * 100,
            ),
          })
        : undefined;
      return {
        context: {
          instructions: context.instructions,
          metadata: JsonRecordSchema.parse({
            ...context.metadata,
            compactedContext: summary,
            compactedTurnId: turn.id,
          }),
          ...(compactedBudget ? { budgetSnapshot: compactedBudget } : {}),
          ...(context.usage ? { usage: context.usage } : {}),
        },
        preservedContextReference: `context:${turn.id}:compacted`,
        summary,
      };
    },
  };
}

function readContextString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readContextRecord(
  metadata: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = metadata[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toUsageSnapshot(
  usage: LLMTextResponse["usage"],
  input: ProviderCallInput,
  cumulative: { cumulativeTokens: number; cumulativeCost: number },
): UsageCostSnapshot {
  return UsageCostSnapshotSchema.parse({
    providerId: usage.provider || input.run.providerId,
    modelId: usage.model || input.run.modelId,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    totalTokens: usage.totalTokens,
    currentTurnCost: usage.cost ?? null,
    cumulativeThreadTokens: cumulative.cumulativeTokens,
    cumulativeThreadCost: cumulative.cumulativeCost,
    currency: "USD",
    measurementSource: "provider",
  });
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
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
  disposition: "recoverable" | "terminal" = "terminal",
): WorkerToolResult {
  return {
    kind: "failed",
    disposition,
    failure: {
      code,
      message,
      details: null,
      retryable,
      correlationId: null,
    },
  };
}

function toolFailureDisposition(
  toolName: string,
  message: string,
  metadata?: unknown,
  failureCode?: string,
): "recoverable" | "terminal" {
  return isTerminalToolFailure({
    toolName,
    error: message,
    failureCode,
    metadata,
  })
    ? "terminal"
    : "recoverable";
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
