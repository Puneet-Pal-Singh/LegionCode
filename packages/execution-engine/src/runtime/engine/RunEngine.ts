import type { CoreMessage, CoreTool } from "ai";
import { RUN_TERMINAL_STATES, RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import { Run, RunRepository, RunStateMachine } from "../run/index.js";
import { Task, TaskRepository } from "../task/index.js";
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
  type CostSnapshot,
} from "../cost/index.js";
import { PlannerService } from "../planner/index.js";
import { TaskScheduler, type TaskExecutor } from "../orchestration/index.js";
import { DefaultTaskExecutor, AgentTaskExecutor } from "./TaskExecutor.js";
import { AgenticLoop } from "./AgenticLoop.js";
import { buildAgenticLoopWorkspaceContext } from "./RunContinuationContext.js";
import { enforceGoldenFlowToolFloor } from "../contracts/CodingToolGateway.js";
import type {
  RunInput,
  RunStatus,
  IAgent,
  RuntimeDurableObjectState,
  WorkspaceBootstrapper,
} from "../types.js";
import type { Plan } from "../planner/index.js";
import { BaseAgent } from "../agents/BaseAgent.js";
import {
  LLMGateway,
  type ILLMGateway,
  type LLMRuntimeAIService,
} from "../llm/index.js";
import {
  MemoryCoordinator,
  MemoryRepository,
  type MemoryCoordinatorDependencies,
  type MemoryContext,
} from "../memory/index.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import {
  getPermissionPolicyMessage,
  evaluateWorkspaceBootstrap,
  processPermissionDirectives as processPermissionDirectivesPolicy,
} from "./RunPermissionWorkspacePolicy.js";
import {
  createStreamResponse,
  completeRunWithAssistantMessage as completeRunWithAssistantMessagePolicy,
  completeRunWithRecoveredAssistantMessage as completeRunWithRecoveredAssistantMessagePolicy,
  getRunDurationMs as getRunDurationMsPolicy,
  tryHandlePlanningError as tryHandlePlanningErrorPolicy,
  type RunCompletionDependencies,
} from "./RunCompletionPolicy.js";
import { createRunManifest, ensureManifestMatch } from "./RunManifestPolicy.js";
import { sanitizeUserFacingOutput } from "./RunOutputSanitizer.js";
import {
  transitionRunToCompleted,
  transitionRunToFailed,
} from "./RunStatusPolicy.js";
import {
  buildAgenticLoopFinalMessage,
  getAgenticLoopMaxSteps,
  recordAgenticLoopMetadata,
} from "./RunAgenticLoopPolicy.js";
import {
  buildPlanModeResponse,
  persistPlanArtifact,
} from "./RunPlanModePolicy.js";
import {
  isPlatformApprovalOwner,
  recordLifecycleStep,
  recordOrchestrationActivation,
  recordOrchestrationTerminal,
  recordPhaseSelectionSnapshot,
  recordTurnModeDecision,
} from "./RunMetadataPolicy.js";
import { resolveRunPermissionContext } from "./RunPermissionContextPolicy.js";
import { PermissionGateError } from "./PermissionGateError.js";
import {
  buildApprovalDecisionMessage,
  extractApprovalDecision,
} from "./RunApprovalDecisionPolicy.js";
import { resetRecyclableRun } from "./RunRecyclableResetPolicy.js";
import { applyReviewerPassIfEnabled } from "./RunReviewerPassPolicy.js";
import { RunEventRecorder, RunEventRepository } from "../events/index.js";
import { tryHandleTaskExecutionErrorPolicy } from "./RunTaskExecutionRecoveryPolicy.js";
import {
  resolveBudgetConfig,
  resolveUnknownPricingMode,
} from "./RunEngineConfigPolicy.js";
import {
  handleExecutionErrorPolicy,
  safeMemoryOperation as safeMemoryOperationPolicy,
} from "./RunEngineReliabilityPolicy.js";
import { describeWorkspaceBootstrapSummary } from "./RunWorkspaceBootstrapSummaryPolicy.js";
import { buildAgenticLoopCallbacks } from "./RunAgenticLoopCallbacksPolicy.js";
import {
  resolveGitTaskStrategyForRun,
  restoreContinuationWorkspaceEditsIfNeeded,
} from "./RunExecutionPreparationPolicy.js";
import {
  buildFinalSummaryFrame,
  appendTerminalDetailsIfNeeded,
  isFinalSummaryContractEnabled,
  resolveNextStepFromSummaryText,
  resolveSummaryReason,
} from "./FinalSummaryBuilder.js";
import {
  resolveLoopTerminalState,
  shouldUseDeterministicTerminalSummary,
} from "./RunTerminalStatePolicy.js";
import type {
  GitHubAuthAvailabilityChecker,
  IRunEngine,
  RunEngineDependencies,
  RunEngineOptions,
} from "./RunEngineTypes.js";

export type {
  IRunEngine,
  RunEngineDependencies,
  RunEngineEnv,
  RunEngineOptions,
} from "./RunEngineTypes.js";

export class RunEngine implements IRunEngine {
  private runRepo: RunRepository;
  private taskRepo: TaskRepository;
  private runEventRepo: RunEventRepository;
  private runEventRecorder: RunEventRecorder;
  private pricingRegistry: IPricingRegistry;
  private costLedger: ICostLedger;
  private costTracker: ICostTracker;
  private budgetManager: IBudgetManager & BudgetPolicy;
  private planner: PlannerService;
  private scheduler: TaskScheduler;
  private taskExecutor: TaskExecutor;
  private aiService?: LLMRuntimeAIService;
  private llmGateway: ILLMGateway;
  private agent?: IAgent;
  private memoryCoordinator: MemoryCoordinator;
  private currentMemoryContext?: MemoryContext;
  private readonly sessionCostsLoaded: Promise<void>;
  private workspaceBootstrapper?: WorkspaceBootstrapper;
  private permissionApprovalStore: PermissionApprovalStore;
  private hasGitHubAuthChecker?: GitHubAuthAvailabilityChecker;

  constructor(
    ctx: RuntimeDurableObjectState,
    private options: RunEngineOptions,
    agent?: IAgent,
    pricingRegistry?: IPricingRegistry,
    dependencies: RunEngineDependencies = {},
  ) {
    this.runRepo = new RunRepository(ctx);
    this.taskRepo = new TaskRepository(ctx);
    this.runEventRepo = new RunEventRepository(ctx);
    this.runEventRecorder = new RunEventRecorder(
      this.runEventRepo,
      options.runId,
      options.sessionId,
      dependencies.runEventListener,
    );

    this.pricingRegistry =
      dependencies.pricingRegistry ??
      pricingRegistry ??
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
    this.sessionCostsLoaded = this.budgetManager.loadSessionCosts();

    this.aiService = dependencies.aiService;

    const pricingResolver =
      dependencies.pricingResolver ??
      new PricingResolver(this.pricingRegistry, {
        unknownPricingMode: resolveUnknownPricingMode(options.env),
      });

    if (dependencies.llmGateway) {
      this.llmGateway = dependencies.llmGateway;
    } else {
      if (!this.aiService) {
        throw new RunEngineError(
          "LLMRuntimeAIService is required when llmGateway is not injected",
        );
      }
      this.llmGateway = new LLMGateway({
        aiService: this.aiService,
        budgetPolicy: this.budgetManager,
        costLedger: this.costLedger,
        pricingResolver,
      });
    }

    this.planner = dependencies.planner ?? new PlannerService(this.llmGateway);
    this.agent = agent;

    // Allow test mode to use DefaultTaskExecutor for isolated testing
    const isTestMode =
      options.env?.NODE_ENV === "test" ||
      options.env?.ALLOW_DEFAULT_EXECUTOR === "true";

    if (!agent && !isTestMode) {
      throw new RunEngineError(
        "Agent is required for production runtime execution. " +
          "Set NODE_ENV=test or ALLOW_DEFAULT_EXECUTOR=true to enable DefaultTaskExecutor for testing.",
      );
    }

    // Use AgentTaskExecutor when agent is provided, otherwise use DefaultTaskExecutor in test mode
    this.taskExecutor = agent
      ? new AgentTaskExecutor(
          agent,
          options.runId,
          options.sessionId,
          this.taskRepo,
          this.runRepo,
        )
      : new DefaultTaskExecutor();
    this.scheduler =
      dependencies.scheduler ??
      new TaskScheduler(this.taskRepo, this.taskExecutor);

    if (dependencies.memoryCoordinator) {
      this.memoryCoordinator = dependencies.memoryCoordinator;
    } else {
      const memoryRepo = new MemoryRepository({ ctx });
      this.memoryCoordinator = new MemoryCoordinator({
        repository: memoryRepo,
        sessionMemoryClient: dependencies.sessionMemoryClient,
      });
    }

    this.workspaceBootstrapper = dependencies.workspaceBootstrapper;
    this.hasGitHubAuthChecker = dependencies.hasGitHubAuth;
    this.permissionApprovalStore = new PermissionApprovalStore(
      ctx,
      options.runId,
    );
  }

  async execute(
    input: RunInput,
    messages: CoreMessage[],
    tools: Record<string, CoreTool>,
  ): Promise<Response> {
    const { runId, sessionId } = this.options;
    const runStartedAt = Date.now();
    try {
      await this.sessionCostsLoaded;
      const run = await this.getOrCreateRun(input, runId, sessionId);
      await this.runEventRecorder.ensureRunStarted(run.status);
      await this.recordCurrentUserTurn(input.prompt);
      recordOrchestrationActivation(run);
      await this.runRepo.update(run);
      console.log(`[run/engine] Retrieving memory context for run ${runId}`);
      this.currentMemoryContext = await this.safeMemoryOperation(() =>
        this.memoryCoordinator.retrieveContext({
          runId,
          sessionId,
          prompt: input.prompt,
          phase: "planning",
        }),
      );
      await this.safeMemoryOperation(() =>
        this.persistConversationMessages(runId, sessionId, messages, "user"),
      );
      recordLifecycleStep(run, "CONTEXT_PREPARED");
      const effectiveInput = run.input;
      const finalSummaryContractEnabled = isFinalSummaryContractEnabled(
        effectiveInput.metadata,
        this.options.env.FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1,
      );
      const runMode = run.metadata.manifest?.mode ?? "build";
      const approvalDecision = extractApprovalDecision(effectiveInput);

      if (approvalDecision) {
        const decisionResult =
          await this.permissionApprovalStore.resolveDecision(
            approvalDecision,
            run.metadata.actorUserId ?? this.options.userId,
          );
        await this.runEventRecorder.recordApprovalResolved({
          requestId: decisionResult.request.requestId,
          decision: decisionResult.decision,
          status:
            decisionResult.status === "approved"
              ? "approved"
              : decisionResult.status === "aborted"
                ? "aborted"
                : "denied",
        });
        recordLifecycleStep(
          run,
          "APPROVAL_WAIT",
          `approval decision resolved (${decisionResult.decision})`,
        );
        const decisionMessage = finalSummaryContractEnabled
          ? buildFinalSummaryFrame({
              terminalState:
                decisionResult.status === "approved"
                  ? RUN_TERMINAL_STATES.APPROVAL_RESOLVED
                  : RUN_TERMINAL_STATES.APPROVAL_DENIED,
              detail: buildApprovalDecisionMessage(decisionResult),
            })
          : buildApprovalDecisionMessage(decisionResult);
        return await this.completeRunWithAssistantMessage(
          run,
          decisionMessage,
          {
            code: "APPROVAL_DECISION_RECORDED",
            requestId: decisionResult.request.requestId,
            decision: decisionResult.decision,
            status: decisionResult.status,
            terminalState:
              decisionResult.status === "approved"
                ? RUN_TERMINAL_STATES.APPROVAL_RESOLVED
                : RUN_TERMINAL_STATES.APPROVAL_DENIED,
          },
        );
      }

      if (
        runMode === "build" &&
        isPlatformApprovalOwner(run.metadata.manifest)
      ) {
        const approvalDirectiveMessage =
          await processPermissionDirectivesPolicy(
            input.prompt,
            this.permissionApprovalStore,
          );
        if (approvalDirectiveMessage) {
          recordLifecycleStep(
            run,
            "APPROVAL_WAIT",
            "approval directive processed",
          );
          console.log(
            `[run/engine] Permission directive processed for run ${runId}`,
          );
          return await this.completeRunWithAssistantMessage(
            run,
            approvalDirectiveMessage,
          );
        }
      } else {
        console.log(
          `[run/engine] Skipping platform approval directives for run ${runId} mode=${runMode}`,
        );
      }

      if (
        runMode === "build" &&
        isPlatformApprovalOwner(run.metadata.manifest)
      ) {
        const permissionMessage = await getPermissionPolicyMessage(
          effectiveInput.prompt,
          effectiveInput.repositoryContext,
          this.permissionApprovalStore,
        );
        if (permissionMessage) {
          recordLifecycleStep(
            run,
            "APPROVAL_WAIT",
            "platform approval required",
          );
          console.log(
            `[run/engine] Permission check blocked action planning for run ${runId}`,
          );
          const message = finalSummaryContractEnabled
            ? buildFinalSummaryFrame({
                terminalState: RUN_TERMINAL_STATES.APPROVAL_REQUIRED,
                detail: permissionMessage,
                nextStep:
                  "Choose an approval action to continue, or deny to stop this path.",
              })
            : permissionMessage;
          return await this.completeRunWithAssistantMessage(run, message, {
            terminalState: RUN_TERMINAL_STATES.APPROVAL_REQUIRED,
          });
        }
      } else {
        console.log(
          `[run/engine] Skipping platform approval gates for run ${runId} mode=${runMode}`,
        );
      }

      if (runMode === "build") {
        const bootstrapEvaluation = await evaluateWorkspaceBootstrap(
          run.id,
          effectiveInput.prompt,
          effectiveInput.repositoryContext,
          this.workspaceBootstrapper,
        );
        run.metadata.workspaceBootstrap = {
          requested: bootstrapEvaluation.status !== "skipped",
          ready: !bootstrapEvaluation.blocked,
          status: bootstrapEvaluation.status,
          mode: bootstrapEvaluation.mode,
          blocked: bootstrapEvaluation.blocked,
          message: bootstrapEvaluation.message ?? undefined,
          expectedMiss: bootstrapEvaluation.expectedMiss,
          clonedDuringBootstrap:
            bootstrapEvaluation.clonedDuringBootstrap ?? false,
          recordedAt: new Date().toISOString(),
        };
        await this.runRepo.update(run);
        if (bootstrapEvaluation.blocked) {
          await this.runEventRecorder.recordRunProgress(
            "planning",
            "Workspace bootstrap",
            describeWorkspaceBootstrapSummary(bootstrapEvaluation),
            "completed",
          );
        }

        if (bootstrapEvaluation.message) {
          const bootstrapLogLabel = bootstrapEvaluation.expectedMiss
            ? "Workspace bootstrap expected miss blocked action planning"
            : "Workspace bootstrap blocked action planning";
          console.log(`[run/engine] ${bootstrapLogLabel} for run ${runId}`);
          return await this.completeRunWithAssistantMessage(
            run,
            bootstrapEvaluation.message,
          );
        }
      }

      if (runMode === "build") {
        return await this.executeAgenticLoopPath(
          run,
          effectiveInput,
          messages,
          enforceGoldenFlowToolFloor(tools, effectiveInput.metadata),
          finalSummaryContractEnabled,
        );
      }

      console.log(
        `[run/engine] Explicit plan mode planning phase for run ${runId}`,
      );
      try {
        const previousPlanningStatus = run.status;
        if (run.status === "CREATED") {
          run.transition("PLANNING");
        }
        if (
          previousPlanningStatus !== run.status ||
          run.status === "PLANNING"
        ) {
          await this.runEventRecorder.recordRunStatusChanged(
            previousPlanningStatus,
            run.status,
            RUN_WORKFLOW_STEPS.PLANNING,
          );
        }
        recordPhaseSelectionSnapshot(run, "planning");
        await this.runRepo.update(run);

        const plan = await this.generatePlan(
          run,
          effectiveInput.prompt,
          this.currentMemoryContext,
        );
        const planArtifact = persistPlanArtifact(run, plan);
        recordLifecycleStep(run, "PLAN_VALIDATED");

        await this.safeMemoryOperation(() =>
          this.memoryCoordinator.createCheckpoint({
            runId,
            sequence: 1,
            phase: "planning",
            runStatus: run.status,
            taskStatuses: {},
          }),
        );
        await this.runRepo.update(run);

        return await this.completeRunWithAssistantMessage(
          run,
          buildPlanModeResponse(planArtifact),
        );
      } catch (planError) {
        const recoveryResponse = await this.tryHandlePlanningError(
          run,
          runId,
          planError,
        );
        if (recoveryResponse) {
          return recoveryResponse;
        }
        transitionRunToFailed(run, runId);
        run.metadata.error =
          planError instanceof Error
            ? planError.message
            : "Planning phase failed";
        await this.runRepo.update(run);
        throw planError;
      }
    } catch (error) {
      await this.handleExecutionError(runId, error);
      throw error;
    }
  }

  private async executeAgenticLoopPath(
    run: Run,
    input: RunInput,
    messages: CoreMessage[],
    tools: Record<string, CoreTool>,
    finalSummaryContractEnabled: boolean,
  ): Promise<Response> {
    console.log(`[run/engine] Agentic loop execution active for run ${run.id}`);
    const previousStatus = run.status;
    run.transition("RUNNING");
    recordPhaseSelectionSnapshot(run, "execution");
    recordLifecycleStep(run, "TASK_EXECUTING", "agentic_loop");
    run.metadata.gitTaskStrategy = await resolveGitTaskStrategyForRun({
      run,
      runInput: input,
      options: this.options,
      hasGitHubAuthChecker: this.hasGitHubAuthChecker,
    });
    await this.runEventRecorder.recordRunStatusChanged(
      previousStatus,
      run.status,
      RUN_WORKFLOW_STEPS.EXECUTION,
    );
    await this.runRepo.update(run);

    const loop = new AgenticLoop(
      {
        maxSteps: getAgenticLoopMaxSteps(run.input.metadata),
        runId: run.id,
        sessionId: run.sessionId,
        budget: this.budgetManager,
        executionNonce: run.createdAt.toISOString(),
      },
      this.llmGateway,
      this.taskExecutor,
    );
    const directExecutionService =
      this.agent instanceof BaseAgent
        ? this.agent.getRuntimeExecutionService()
        : undefined;
    const restoredPersistedEditCount =
      await restoreContinuationWorkspaceEditsIfNeeded(
        run,
        directExecutionService,
      );
    const loopCallbacks = buildAgenticLoopCallbacks({
      run,
      directExecutionService,
      runEventRecorder: this.runEventRecorder,
      permissionApprovalStore: this.permissionApprovalStore,
      runRepo: this.runRepo,
      env: this.options.env,
      runId: this.options.runId,
    });
    try {
      const loopResult = await loop.execute(messages, tools, {
        agentType: run.agentType,
        workspaceContext: buildAgenticLoopWorkspaceContext({
          repositoryContext: input.repositoryContext,
          prompt: input.prompt,
          continuation: run.metadata.continuation,
          workspaceBootstrap: run.metadata.workspaceBootstrap,
          gitTaskStrategy: run.metadata.gitTaskStrategy,
        }),
        isRunCancelled: async () => {
          const currentRun = await this.runRepo.getById(run.id);
          return currentRun?.status === "CANCELLED";
        },
        executeTool: loopCallbacks.executeTool,
        initialCompletedMutatingToolCount: restoredPersistedEditCount,
        modelId: input.modelId,
        providerId: input.providerId,
        runtimeModelId: input.runtimeModelId,
        providerTransport: input.providerTransport,
        providerEndpoint: input.providerEndpoint,
        temperature: 0.2,
        onToolRequested: loopCallbacks.onToolRequested,
        onProgress: async (progress) => {
          if (!progress) return;
          await this.runEventRecorder.recordRunProgress(
            progress.phase,
            progress.label,
            progress.summary,
            progress.status,
          );
        },
        onAssistantMessage: async (content) => {
          const sanitizedContent = sanitizeUserFacingOutput(content).trim();
          if (!sanitizedContent) {
            return;
          }
          await this.runEventRecorder.recordMessageEmitted(
            "assistant",
            sanitizedContent,
            undefined,
            {
              phase: "commentary",
              status: "completed",
            },
          );
        },
        onToolStarted: loopCallbacks.onToolStarted,
        onToolCompleted: loopCallbacks.onToolCompleted,
        onToolFailed: loopCallbacks.onToolFailed,
      });
      recordAgenticLoopMetadata(run, loopResult);
      if (loopResult.stopReason === "cancelled") {
        console.log(
          `[run/engine] Agentic loop observed cancellation for run ${run.id}`,
        );
        return createStreamResponse("");
      }
      const finalMessage = buildAgenticLoopFinalMessage(loopResult);
      const terminalState = resolveLoopTerminalState({
        loopResult,
        metadata: finalMessage.metadata,
      });
      const shouldFrameTerminalSummary =
        finalSummaryContractEnabled ||
        terminalState === RUN_TERMINAL_STATES.FAILED_TOOL;
      const finalOutput = finalMessage.metadata
        ? shouldFrameTerminalSummary &&
          shouldUseDeterministicTerminalSummary(terminalState)
          ? appendTerminalDetailsIfNeeded({
              framedOutput: buildFinalSummaryFrame({
                terminalState,
                detail: resolveSummaryReason(finalMessage.text),
                nextStep:
                  (typeof finalMessage.metadata.resumeHint === "string"
                    ? finalMessage.metadata.resumeHint
                    : undefined) ??
                  resolveNextStepFromSummaryText(finalMessage.text),
              }),
              originalText: finalMessage.text,
              includeDetails:
                !finalSummaryContractEnabled &&
                terminalState === RUN_TERMINAL_STATES.FAILED_TOOL,
            })
          : finalMessage.text
        : await applyReviewerPassIfEnabled({
            run,
            originalPrompt: input.prompt,
            synthesisOutput: sanitizeUserFacingOutput(finalMessage.text),
            llmGateway: this.llmGateway,
          });
      const mergedMetadata: Record<string, unknown> = {
        ...(finalMessage.metadata ?? {}),
        terminalState,
      };
      return this.completeRunWithAssistantMessage(
        run,
        finalOutput,
        mergedMetadata,
      );
    } catch (error) {
      if (error instanceof PermissionGateError) {
        const gateResult = error.gateResult;
        if (gateResult.kind === "ask") {
          const message = finalSummaryContractEnabled
            ? buildFinalSummaryFrame({
                terminalState: RUN_TERMINAL_STATES.APPROVAL_REQUIRED,
                detail: error.message,
                nextStep:
                  "Choose an approval action to continue, or deny to stop this path.",
              })
            : error.message;
          return this.completeRunWithAssistantMessage(run, message, {
            code: "APPROVAL_REQUIRED",
            approvalRequest: gateResult.request,
            terminalState: RUN_TERMINAL_STATES.APPROVAL_REQUIRED,
          });
        }
        const currentRun = await this.runRepo.getById(run.id);
        if (currentRun?.status === "CANCELLED") {
          console.log(
            `[run/engine] Returning empty response for cancelled run ${run.id}`,
          );
          return createStreamResponse("");
        }
        const denialReason =
          gateResult.kind === "deny" ? gateResult.reason : error.message;
        const message = finalSummaryContractEnabled
          ? buildFinalSummaryFrame({
              terminalState: RUN_TERMINAL_STATES.APPROVAL_DENIED,
              detail: denialReason,
              nextStep:
                "If you want to proceed, allow the action in a new approval decision.",
            })
          : error.message;
        return this.completeRunWithAssistantMessage(run, message, {
          code: "PERMISSION_DENIED",
          reason: denialReason,
          terminalState: RUN_TERMINAL_STATES.APPROVAL_DENIED,
        });
      }
      const recoveryResponse = await this.tryHandleTaskExecutionError(
        run,
        run.input.prompt,
        loop,
        error,
      );
      if (recoveryResponse) {
        return recoveryResponse;
      }
      throw error;
    }
  }

  private async persistConversationMessages(
    runId: string,
    sessionId: string,
    messages: CoreMessage[],
    role: "user" | "assistant",
  ): Promise<void> {
    for (const message of messages) {
      if (typeof message.content === "string" && message.content.trim()) {
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

  private getRunCompletionDependencies(): RunCompletionDependencies {
    return {
      memoryCoordinator: this.memoryCoordinator,
      persistConversationMessages: this.persistConversationMessages.bind(this),
      runEventRecorder: this.runEventRecorder,
      runRepo: this.runRepo,
      safeMemoryOperation: this.safeMemoryOperation.bind(this),
    };
  }

  private async recordCurrentUserTurn(prompt: string): Promise<void> {
    await this.runEventRecorder.recordMessageEmitted("user", prompt);
  }

  async getRunStatus(runId: string): Promise<RunStatus | null> {
    const run = await this.runRepo.getById(runId);
    return run?.status ?? null;
  }

  async cancel(runId: string): Promise<boolean> {
    const run = await this.runRepo.getById(runId);
    const terminalStatuses: RunStatus[] = [
      "COMPLETED",
      "FAILED",
      "PAUSED",
      "CANCELLED",
    ];
    if (!run || terminalStatuses.includes(run.status)) {
      return false;
    }
    const previousStatus = run.status;
    run.transition("CANCELLED");
    recordLifecycleStep(run, "TERMINAL", "status=CANCELLED");
    recordOrchestrationTerminal(run);
    const cancelled = await this.runRepo.updateUnlessStatus(
      run,
      terminalStatuses,
    );
    if (!cancelled) {
      return false;
    }
    await this.runEventRecorder.recordRunStatusChanged(
      previousStatus,
      run.status,
      RUN_WORKFLOW_STEPS.EXECUTION,
      "user_cancelled",
    );
    if (
      isFinalSummaryContractEnabled(
        run.input.metadata,
        this.options.env.FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1,
      )
    ) {
      await this.runEventRecorder.recordMessageEmitted(
        "assistant",
        buildFinalSummaryFrame({
          terminalState: RUN_TERMINAL_STATES.INTERRUPTED,
          detail: "The run was cancelled before execution could finish.",
          nextStep: "Resubmit the request when you want me to continue.",
        }),
        { terminalState: RUN_TERMINAL_STATES.INTERRUPTED },
      );
    }
    const tasks = await this.taskRepo.getByRun(runId);
    for (const task of tasks) {
      if (["PENDING", "READY", "RUNNING"].includes(task.status)) {
        task.transition("CANCELLED");
        await this.taskRepo.update(task);
      }
    }

    console.log(`[run/engine] Cancelled run ${runId}`);
    return true;
  }

  private async getOrCreateRun(
    input: RunInput,
    runId: string,
    sessionId: string,
  ): Promise<Run> {
    const existing = await this.runRepo.getById(runId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new RunEngineError(
          `runId ${runId} is already associated with a different session`,
        );
      }

      const isTerminal = RunStateMachine.isTerminalState(existing.status);
      const isIdleCreated =
        existing.status === "CREATED" &&
        (await this.taskRepo.getByRun(runId)).length === 0;

      if (isTerminal || isIdleCreated) {
        const resetRun = await resetRecyclableRun({
          runId,
          sessionId,
          input,
          previousStatus: existing.status,
          existingRun: existing,
          taskRepo: this.taskRepo,
          runRepo: this.runRepo,
          createFreshRun: this.createFreshRun.bind(this),
        });
        await this.runEventRecorder.clear();
        return resetRun;
      }

      const requestedManifest = createRunManifest(input);
      ensureManifestMatch(existing.metadata.manifest, requestedManifest);

      return existing;
    }

    const run = this.createFreshRun(runId, sessionId, input);

    await this.runRepo.create(run);
    console.log(`[run/engine] Created new run ${runId}`);

    return run;
  }

  private createFreshRun(
    runId: string,
    sessionId: string,
    input: RunInput,
  ): Run {
    const manifest = createRunManifest(input);
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
        manifest,
        permissionContext: resolveRunPermissionContext(input),
        orchestrationTelemetry: {
          activeDurationMs: 0,
          wakeupCount: 0,
          resumeCount: 0,
        },
        lifecycleSteps: [
          {
            step: "RUN_CREATED",
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    );
  }

  private async generatePlan(
    run: Run,
    prompt: string,
    memoryContext?: MemoryContext,
  ): Promise<Plan> {
    if (this.agent) {
      return this.agent.plan({ run, prompt, history: undefined });
    }
    return this.planner.plan(run, prompt, memoryContext);
  }

  private async processPermissionDirectives(
    prompt: string,
  ): Promise<string | null> {
    return processPermissionDirectivesPolicy(
      prompt,
      this.permissionApprovalStore,
    );
  }

  private async getPermissionPolicyMessage(
    prompt: string,
    repositoryContext?: { owner?: string; repo?: string },
  ): Promise<string | null> {
    return getPermissionPolicyMessage(
      prompt,
      repositoryContext,
      this.permissionApprovalStore,
    );
  }

  private async getWorkspaceBootstrapMessage(
    runId: string,
    prompt: string,
    repositoryContext?: { owner?: string; repo?: string; branch?: string },
  ): Promise<string | null> {
    const evaluation = await evaluateWorkspaceBootstrap(
      runId,
      prompt,
      repositoryContext,
      this.workspaceBootstrapper,
    );
    return evaluation.message;
  }

  private async completeRunWithAssistantMessage(
    run: Run,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<Response> {
    return completeRunWithAssistantMessagePolicy({
      run,
      text,
      metadata,
      deps: this.getRunCompletionDependencies(),
    });
  }

  private async completeRunWithRecoveredAssistantMessage(
    run: Run,
    text: string,
    metadata?: Record<string, unknown>,
    errorMetadata?: string,
    terminalStatus?: "COMPLETED" | "PAUSED",
  ): Promise<Response> {
    return completeRunWithRecoveredAssistantMessagePolicy({
      run,
      text,
      metadata,
      errorMetadata,
      terminalStatus,
      deps: this.getRunCompletionDependencies(),
    });
  }

  private async tryHandlePlanningError(
    run: Run,
    runId: string,
    error: unknown,
  ): Promise<Response | null> {
    return tryHandlePlanningErrorPolicy({
      run,
      runId,
      error,
      deps: this.getRunCompletionDependencies(),
    });
  }

  private async handleExecutionError(
    runId: string,
    error: unknown,
  ): Promise<void> {
    await handleExecutionErrorPolicy({
      runId,
      error,
      runRepo: this.runRepo,
      runEventRecorder: this.runEventRecorder,
      getRunDurationMs: this.getRunDurationMs.bind(this),
    });
  }

  private async safeMemoryOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    return safeMemoryOperationPolicy(operation);
  }
  async getCostSnapshot(runId: string): Promise<CostSnapshot> {
    return this.costLedger.aggregate(runId);
  }
  async getTasksForRun(runId: string) {
    return this.taskRepo.getByRun(runId);
  }
  async getRun(runId: string) {
    return this.runRepo.getById(runId);
  }

  private getRunDurationMs(run: Run): number {
    return getRunDurationMsPolicy(run);
  }

  private async tryHandleTaskExecutionError(
    run: Run,
    prompt: string,
    loop: AgenticLoop,
    error: unknown,
  ): Promise<Response | null> {
    return tryHandleTaskExecutionErrorPolicy({
      run,
      prompt,
      loop,
      error,
      deps: {
        completeRunWithRecoveredAssistantMessage:
          this.completeRunWithRecoveredAssistantMessage.bind(this),
        runEventRecorder: this.runEventRecorder,
      },
    });
  }
}

export class RunEngineError extends Error {
  constructor(message: string) {
    super(`[run/engine] ${message}`);
    this.name = "RunEngineError";
  }
}
