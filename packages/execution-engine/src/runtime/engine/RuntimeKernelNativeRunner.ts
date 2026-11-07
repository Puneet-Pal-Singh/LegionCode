import { readPreExecutionRejection } from "../tools/PreExecutionRejection.js";
import type { CoreMessage, CoreTool } from "ai";
import {
  createNativeContextAssembly,
  createNativeContextCompaction,
} from "./NativeRuntimeContext.js";
import {
  JsonRecordSchema,
  PermissionProfileIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  ThreadIdSchema,
  TurnSchema,
  TurnIdSchema,
  WorkerIdSchema,
  type ApprovalDecision,
  type ApprovalRequestedPayload,
  type Run as ProtocolRun,
  type RunAttemptId,
  type ToolCallItemContent,
  type Turn,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type {
  ApprovalResolution,
  ApprovalWaitPort,
  RuntimeGitSnapshotPort,
  RuntimeKernelDependencies,
  RuntimeLifecycleEventStore,
  RuntimeHookOrchestrationPort,
  RuntimeTurnArtifactPort,
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
import { BaseAgent } from "../agents/BaseAgent.js";
import {
  enforceCodingToolFloor,
  getCodingCoreToolRegistry,
  isCodingToolId,
} from "../tools/CodingToolRegistry.js";
import type {
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
  registerRuntimeModelPricing,
  type BudgetPolicy,
  type IBudgetManager,
  type ICostLedger,
  type ICostTracker,
  type IPricingRegistry,
} from "../cost/index.js";
import {
  buildAgenticLoopFinalMessage,
  getAgenticLoopMaxSteps,
  recordAgenticLoopMetadata,
} from "./RunAgenticLoopPolicy.js";
import { getNativeToolCallSafetyLimit } from "./NativeProviderStepBudget.js";
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
import { KernelAgenticProvider, type NativeModelStepProgress } from "./KernelAgenticProvider.js";
import { toProtocolId } from "./NativeProtocolIdentity.js";
import {
  NativeRunCancelledError,
  assertNativeRunNotCancelled,
  assertSignalNotAborted,
  runWithNativeCancellationPolling,
} from "./NativeRunCancellation.js";

type KernelWorkspaceManifest = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<RuntimeKernelDependencies["workspaceManifests"]>["getLatestByRunId"]
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
  /** The latest terminal turn superseded by this edited/recovery turn. */
  revisionOfTurnId?: string;
  continuationOfTurnId?: string;
  originalPromptId?: string;
  workspace: {
    filesystemRoot: string;
    workingBranch: string;
    startTreeId: string;
    artifactNamespace: string;
  } | null;
  now?: () => string;
}

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
    private readonly dependencies: RunEngineDependencies = {},
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

  private async recordModelStepStarted(progress: NativeModelStepProgress): Promise<void> {
    await this.runEventRecorder.recordRunProgress(
      RUN_WORKFLOW_STEPS.EXECUTION,
      "Thinking",
      "",
      "active",
      {
        displayMode: "visible",
        metadata: {
          owner: "runtime-kernel-native", step: progress.step,
          turnId: progress.turnId, requiresMutation: progress.requiresMutation,
        },
      },
    );
  }

  private async recordModelStepCompleted(progress: NativeModelStepProgress): Promise<void> {
    await this.runEventRecorder.recordRunProgress(
      RUN_WORKFLOW_STEPS.EXECUTION,
      "Thinking",
      "",
      "completed",
      {
        displayMode: "debug",
        metadata: { owner: "runtime-kernel-native", step: progress.step, turnId: progress.turnId },
      },
    );
  }

  private async executeActiveTurn(
    input: RuntimeKernelNativeRunnerInput,
  ): Promise<Response> {
    await this.budgetManager.loadSessionCosts();
    const run = await this.getOrCreateRun(input.input);
    await this.prepareRun(run, input);
    if (input.workspace && run.metadata.manifest?.mode !== "build") {
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
    const runtimeTools = input.workspace ? enforceCodingToolFloor(
      { ...getCodingCoreToolRegistry(), ...input.tools }, input.input.metadata,
    ) : {};
    recordTurnModeDecision(run, {
      mode: input.workspace ? "action" : "chat",
      source: "runtime-kernel",
      rationale: "Repository and conversation turns use the canonical runtime kernel path.",
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
      revisionOfTurnId: input.revisionOfTurnId,
      continuationOfTurnId: input.continuationOfTurnId,
      originalPromptId: input.originalPromptId,
      workspace: input.workspace,
    });
    const maxSteps = getAgenticLoopMaxSteps(input.input.metadata);
    const provider = new KernelAgenticProvider({
      runId: run.id, conversationId: run.sessionId, agentType: run.agentType,
      workspaceHints: run.metadata,
      input: input.input,
      messages: input.workspace ? input.messages : [{ role: "system", content: "This conversation has no project or repository. You can answer questions and help plan work. You have no filesystem, terminal, Git, or repository tools. If the user asks you to inspect or change repository files, ask them to select a project. Never claim to have inspected or edited files." }, ...input.messages],
      tools: runtimeTools,
      llmGateway: this.llmGateway,
      budget: this.budgetManager,
      legacyObserver: this.runEventRecorder,
      modelStepObserver: {
        started: this.recordModelStepStarted.bind(this),
        completed: this.recordModelStepCompleted.bind(this),
      },
      isRunCancelled: this.isRunCancelled.bind(this),
      maxSteps,
      rootPromptId: input.originalPromptId,
    });
    const worker = protocol.manifest
      ? this.createRepositoryWorker(protocol.manifest, protocol.runAttemptId, protocol.turn, provider, runtimeTools, input.input)
      : { executeTool: async (): Promise<WorkerToolResult> => failed("policy_denied", "Select a project before using repository tools.", false, "terminal"), awaitQuiescence: async () => true };
    const kernel = new RuntimeKernel({
      lifecycleEvents: input.lifecycleEvents,
      workspaceManifests: protocol.manifest ? createWorkspaceManifestRepository(protocol.manifest) : undefined,
      gitSnapshots:
        protocol.manifest ? this.gitSnapshots ?? createUnavailableSnapshotPort(protocol.manifest) : undefined,
      turnArtifacts: createTurnArtifactPort(),
      contextAssembly: createNativeContextAssembly(
        input.input,
        provider.readContextMessages.bind(provider),
        runtimeTools,
      ),
      contextCompaction: createNativeContextCompaction(
        input.input,
        provider.readContextMessages.bind(provider),
        provider.readTaskContextProjection.bind(provider),
      ),
      provider,
      worker,
      toolAuthorization: new RegistryToolAuthorization(
        new NativePermissionPolicyResolver(
          requirePersistedPermissionContext(run).state.productMode,
        ),
        this.dependencies.approvalGrants,
        this.options.userId
          ? toProtocolId("usr", this.options.userId)
          : undefined,
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

  async acceptThreadInput(input: {
    readonly turnId: Turn["id"];
    readonly inputId: string;
    readonly clientInputId: string;
    readonly transcriptMessageId: string;
    readonly message: CoreMessage;
  }): Promise<number> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.turnId !== input.turnId || !activeTurn.kernel) {
      throw new RuntimeKernelError(
        "turn_not_active",
        `Turn ${input.turnId} has no active runtime owner`,
      );
    }
    return await activeTurn.kernel.acceptThreadInput({
      turnId: input.turnId,
      accepted: {
        inputId: input.inputId,
        message: { ...input.message, id: input.transcriptMessageId } as unknown as CoreMessage,
      },
      clientInputId: input.clientInputId,
      transcriptMessageId: input.transcriptMessageId,
    });
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

  private createRepositoryWorker(manifest: KernelWorkspaceManifest, runAttemptId: RunAttemptId, turn: Turn, provider: KernelAgenticProvider, runtimeTools: Record<string, CoreTool>, input: RunInput): KernelToolWorker {
    const capabilityManifest = createCloudSandboxRunCapabilityManifest({
      runId: manifest.runId, workspaceRoot: manifest.filesystemRoot,
      artifactRoot: `${manifest.filesystemRoot}/artifacts`, availableToolIds: Object.keys(runtimeTools),
      providerId: input.providerId, modelId: input.runtimeModelId ?? input.modelId,
    });
    return new KernelToolWorker({
      runEventRecorder: this.runEventRecorder, tracker: provider, isRunCancelled: this.isRunCancelled.bind(this),
      toolGateway: new RuntimeToolGateway({ executor: this.getDirectExecutionService(), manifest: capabilityManifest,
        scope: new RuntimeWorkspaceScope({ runId: manifest.runId, threadId: turn.threadId, turnId: turn.id,
          runAttemptId, workspaceId: manifest.workspaceId, root: manifest.filesystemRoot }),
      }),
    });
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

class KernelToolWorker implements WorkerProtocolPort {
  private readonly preExecutionRejections = new Set<string>();
  private readonly activeToolOperations = new Map<Turn["id"], Set<Promise<unknown>>>();
  private readonly uncertainCancelledTurns = new Set<Turn["id"]>();
  constructor(
    private readonly options: {
      runEventRecorder: RunEventRecorder;
      tracker: KernelAgenticProvider;
      isRunCancelled: () => Promise<boolean>;
      toolGateway: RuntimeToolGateway;
    },
  ) {}

  async awaitQuiescence(input: {
    readonly turnId: Turn["id"];
    readonly timeoutMs: number;
  }): Promise<boolean> {
    if (this.uncertainCancelledTurns.has(input.turnId)) return false;
    const pending = [...(this.activeToolOperations.get(input.turnId) ?? [])];
    if (pending.length === 0) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Tool quiescence timed out")), input.timeoutMs);
        }),
      ]);
      return (this.activeToolOperations.get(input.turnId)?.size ?? 0) === 0;
    } catch {
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

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
      const operation = this.options.toolGateway.execute({
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
        });
      this.trackToolOperation(input.turnId, operation, input.signal);
      const gatewayResult = await runWithNativeCancellationPolling(
        operation,
        this.options.isRunCancelled,
      );
      if (gatewayResult.kind === "cancelled") {
        return { kind: "cancelled", reason: "Run cancelled by user." };
      }
      assertSignalNotAborted(input.signal);
      if (gatewayResult.kind === "failed") {
        const preExecutionRejection = readPreExecutionRejection(
          gatewayResult.failure?.details,
        );
        const rejectionKey = preExecutionRejection
          ? `${input.turnId}:${toolName}:${preExecutionRejection.ruleId}`
          : null;
        const correctionAlreadyUsed =
          rejectionKey !== null &&
          this.preExecutionRejections.has(rejectionKey);
        if (rejectionKey && !correctionAlreadyUsed) {
          this.preExecutionRejections.add(rejectionKey);
        }
        const failure =
          correctionAlreadyUsed &&
          preExecutionRejection &&
          gatewayResult.failure
            ? {
                ...gatewayResult.failure,
                message: `The command was rejected before execution, so this request is incomplete. ${gatewayResult.failure.message} One corrected retry for this validation rule was already rejected; use an approved typed tool or request user guidance.`,
                details: {
                  ...preExecutionRejection,
                  correctionLimitReached: true,
                  nextStep:
                    "Use an approved typed tool or request user guidance.",
                },
              }
            : gatewayResult.failure;
        const message =
          failure?.message ??
          gatewayResult.result.error?.message ??
          "Tool execution failed";
        const gatewayFailureCode =
          gatewayResult.code === "executor_failed"
            ? "command_failed"
            : gatewayResult.code === "tool_unavailable"
              ? "not_found"
              : gatewayResult.code === "workspace_escape_denied"
                ? "policy_denied"
                : "validation_failed";
        const failureCode = failure?.code ?? gatewayFailureCode;
        const disposition = correctionAlreadyUsed
          ? "terminal"
          : toolFailureDisposition(
              toolName,
              message,
              failure?.details,
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
        if (failure) {
          return {
            kind: "failed",
            failure,
            disposition:
              failure.code === "worker_unavailable" ? "terminal" : disposition,
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

  private trackToolOperation(
    turnId: Turn["id"],
    operation: Promise<unknown>,
    signal?: AbortSignal,
  ): void {
    let pending = this.activeToolOperations.get(turnId);
    if (!pending) {
      pending = new Set();
      this.activeToolOperations.set(turnId, pending);
    }
    pending.add(operation);
    let settled = false;
    const onAbort = () => {
      if (!settled) this.uncertainCancelledTurns.add(turnId);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const remove = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      this.removeToolOperation(turnId, operation);
    };
    void operation.then(remove, remove);
  }

  private removeToolOperation(turnId: Turn["id"], operation: Promise<unknown>): void {
    const pending = this.activeToolOperations.get(turnId);
    pending?.delete(operation);
    if (pending?.size === 0) this.activeToolOperations.delete(turnId);
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
      ...(outcome.outcome === "timed_out" ? { timedOut: true } : {}),
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
  revisionOfTurnId?: string;
  continuationOfTurnId?: string;
  originalPromptId?: string;
  workspace: RuntimeKernelNativeRunnerInput["workspace"];
}): {
  run: ProtocolRun;
  turn: Turn;
  runAttemptId: RunAttemptId;
  manifest: KernelWorkspaceManifest | null;
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
    executionCapability: input.workspace ? "repository" : "conversation",
    startedAt: input.timestamp,
    completedAt: null,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    lastEventSequence: 0,
  });
  const manifest = input.workspace ? {
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
  } satisfies KernelWorkspaceManifest : null;
  return {
    run,
    turn: TurnSchema.parse({
      id: input.turnId,
      threadId,
      runId: input.runId,
      parentTurnId: input.revisionOfTurnId
        ? TurnIdSchema.parse(input.revisionOfTurnId)
        : null,
      status: "queued",
      startedAt: null,
      completedAt: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      lastEventSequence: 0,
    }),
    runAttemptId,
    ...(input.continuationOfTurnId
      ? {
          continuationOfTurnId: TurnIdSchema.parse(input.continuationOfTurnId),
          originalPromptId: input.originalPromptId,
        }
      : {}),
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
