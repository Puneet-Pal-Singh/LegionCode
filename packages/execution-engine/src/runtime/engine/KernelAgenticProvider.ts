import { buildNativeKernelTerminalMessage, resolveNativeKernelTerminalState } from "./NativeTerminalFailurePresentation.js";
import type { CoreMessage, CoreTool } from "ai";
import {
  ItemIdSchema,
  ToolCallBatchIdSchema,
  ToolCallItemContentSchema,
  UsageCostSnapshotSchema,
  type ToolCallItemContent,
  type UsageCostSnapshot,
  projectVisibleTranscriptText,
} from "@repo/platform-protocol";
import type {
  ProviderCallInput,
  ProviderPort,
  ProviderStep,
  AcceptedThreadInput,
  ToolResult,
} from "@repo/runtime-kernel";
import { ReasoningEffortSchema, RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import { isMutatingCodingToolId } from "../tools/CodingToolRegistry.js";
import type {
  AgenticLoopToolLifecycleEvent,
  RunInput,
  TaskResult,
} from "../types.js";
import type { Run } from "../run/index.js";
import type { RunEventRecorder } from "../events/index.js";
import { type ILLMGateway, type LLMTextResponse } from "../llm/index.js";
import { type IBudgetManager } from "../cost/index.js";
import {
  buildAgenticLoopSystemPrompt,
  buildAssistantMessage,
  buildToolResultMessage,
  type AgenticLoopToolCall,
  type AgenticLoopToolResult,
  type StopReason,
} from "./AgenticLoop.js";
import { shouldRetryNativeFinalOnlyResponse } from "./NativeProviderFinalRecoveryPolicy.js";
import { buildNativeProviderMessages } from "./NativeProviderFinalRecoveryMessages.js";
import {
  generateNativeProviderFinalRecovery,
  initialNativeFinalRecoveryAttempts,
} from "./NativeProviderFinalRecovery.js";
import { buildAgenticLoopWorkspaceContext } from "./RunContinuationContext.js";
import { formatRuntimeDiagnosticLogLine } from "../lib/RuntimeDiagnosticLog.js";
import { RuntimeKernelProviderTranscript } from "./RuntimeKernelProviderTranscript.js";
import { ProviderToolCallIdentityMap } from "./ProviderToolCallIdentityMap.js";
import { buildProviderContextMessages } from "./NativeProviderContextMessages.js";
import { runWithProviderRequestRecovery } from "./NativeProviderRequestRecovery.js";
import {
  buildProviderRecoveryIdempotencyKey,
  buildProviderRecoveryProgress,
} from "./NativeProviderRecoveryProgress.js";
import { resolveModelCommentary } from "./NativeProviderCommentary.js";
import { projectTaskContext } from "./TaskContextProjection.js";
import { NativeTurnInputBuffer } from "./NativeTurnInput.js";
import { toProtocolId } from "./NativeProtocolIdentity.js";
import {
  assertNativeRunNotCancelled,
  assertSignalNotAborted,
  runWithNativeCancellationPolling,
} from "./NativeRunCancellation.js";

type NativeProviderCallContext = {
  runId: string;
  turnId: string;
  sessionId: string;
  agentType: string;
  phase: "task" | "synthesis";
  idempotencyKey: string;
};

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

export interface NativeModelStepProgress {
  readonly turnId: ProviderCallInput["turn"]["id"];
  readonly step: number;
  readonly requiresMutation: boolean;
}

export class KernelAgenticProvider implements ProviderPort {
  private readonly messages: CoreMessage[];
  private readonly activeTaskStartIndex: number;
  private readonly threadInputBuffer = new NativeTurnInputBuffer();
  private readonly pendingToolCalls: AgenticLoopToolCall[] = [];
  private pendingToolCallBatchId:
    | import("@repo/platform-protocol").ToolCallBatchId
    | null = null;
  private pendingUsage: UsageCostSnapshot | null = null;
  private cumulativeTokens = 0;
  private cumulativeCost = 0;
  private pendingCommentary: string | null = null;
  private pendingReasoningSummary: LLMTextResponse["reasoningSummary"] =
    undefined;
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
      runId: string;
      conversationId: string;
      agentType: string;
      workspaceHints?: Pick<
        Run["metadata"],
        "continuation" | "workspaceBootstrap" | "gitTaskStrategy"
      >;
      input: Pick<
        RunInput,
        | "modelId"
        | "providerId"
        | "runtimeModelId"
        | "providerTransport"
        | "providerEndpoint"
        | "repositoryContext"
        | "metadata"
      >;
      messages: CoreMessage[];
      tools: Record<string, CoreTool>;
      llmGateway: Pick<ILLMGateway, "generateText">;
      budget?: Pick<IBudgetManager, "isOverBudget">;
      legacyObserver?: Pick<
        RunEventRecorder,
        "recordRunProgress" | "recordMessageEmitted" | "recordToolRequested"
      >;
      modelStepObserver?: {
        started(progress: NativeModelStepProgress): Promise<void>;
        completed(progress: NativeModelStepProgress): Promise<void>;
      };
      isRunCancelled: () => Promise<boolean>;
      maxSteps: number;
      rootPromptId?: string;
    },
  ) {
    const taskContext = projectTaskContext({
      messages: options.messages,
      ...(options.rootPromptId ? { rootPromptId: options.rootPromptId } : {}),
    });
    this.messages = [...taskContext.messages];
    this.activeTaskStartIndex = taskContext.activeTaskStartIndex;
    this.requiresMutation = false;
  }

  async readContextMessages(
    toolResults?: readonly ToolResult[],
  ): Promise<readonly CoreMessage[]> {
    if (toolResults) await this.collectNewToolResults(toolResults);
    return [...this.messages];
  }

  async readTaskContextProjection(): Promise<{
    readonly messages: readonly CoreMessage[];
    readonly activeTaskStartIndex: number;
  }> {
    const projection = projectTaskContext({
      messages: this.messages,
      activeTaskStartIndex: this.activeTaskStartIndex,
    });
    return {
      messages: projection.messages,
      activeTaskStartIndex: projection.activeTaskStartIndex,
    };
  }

  enqueueThreadInput(input: AcceptedThreadInput): void {
    this.threadInputBuffer.enqueue(input);
  }

  hasPendingThreadInputs(): boolean {
    return this.threadInputBuffer.hasPending();
  }

  async flushThreadInputs(): Promise<boolean> {
    if (this.pendingToolCalls.length > 0) return false;
    return this.threadInputBuffer.flush((messages) =>
      this.messages.push(...messages),
    );
  }

  private async acknowledgeStagedThreadInputs(
    input: ProviderCallInput,
  ): Promise<void> {
    await this.threadInputBuffer.acknowledge(
      this.stepsExecuted + 1,
      input.onThreadInputsApplied,
    );
  }

  async generateNext(input: ProviderCallInput): Promise<ProviderStep> {
    assertSignalNotAborted(input.signal);
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    await this.collectNewToolResults(input.toolResults);
    const queued = this.shiftQueuedToolCall();
    if (queued) return queued;
    const stagedInputs = await this.flushThreadInputs();
    const providerContext = stagedInputs
      ? ((await input.refreshContext?.()) ?? input.context)
      : input.context;
    await assertNativeRunNotCancelled(this.options.isRunCancelled);
    if (await this.options.budget?.isOverBudget(this.options.runId)) {
      this.stopReason = "budget_exceeded";
      return {
        kind: "complete",
        itemId: ItemIdSchema.parse(
          toProtocolId("itm", `${input.run.id}-budget`),
        ),
        output: "The run stopped because its configured budget was exceeded.",
      };
    }
    let finalOnlyRecoveryAttempts = initialNativeFinalRecoveryAttempts(
      this.stepsExecuted,
      this.options.maxSteps,
    );
    let responseParts: LLMTextResponse["parts"];
    let responseUsage: LLMTextResponse["usage"] | null = null;
    let responseReasoningSummary: LLMTextResponse["reasoningSummary"];
    let toolCalls: AgenticLoopToolCall[];
    let visibleText: string;

    do {
      await this.recordModelStepStarted(input);
      const finalRecovery = finalOnlyRecoveryAttempts > 0;
      const context = {
        runId: this.options.runId,
        turnId: input.turn.id,
        sessionId: this.options.conversationId,
        agentType: this.options.agentType,
        phase: finalRecovery ? ("synthesis" as const) : ("task" as const),
        idempotencyKey: `runtime-kernel-native:${this.options.runId}:turn:${input.turn.id}:step:${this.stepsExecuted + 1}:${finalRecovery ? `final-${finalOnlyRecoveryAttempts}` : "task"}`,
      };
      const contextMessages = buildProviderContextMessages({
        messages: this.messages,
        compactedContext: readContextString(
          providerContext.metadata,
          "compactedContext",
        ),
        activeTaskStartIndex: this.activeTaskStartIndex,
      });
      const messages = buildNativeProviderMessages(
        contextMessages,
        finalOnlyRecoveryAttempts,
      );

      if (finalRecovery) {
        const recovered = await this.requestWithProviderRecovery(
          input,
          context,
          async (attemptContext) => {
            const request = generateNativeProviderFinalRecovery(
              this.options.llmGateway,
              {
                context: attemptContext,
                messages,
                system: buildAgenticLoopSystemPrompt({
                  finalSynthesisOnly: true,
                  requiresMutation: this.requiresMutation,
                  completedMutatingToolCount: this.completedMutatingToolCount,
                  completedReadOnlyToolCount: this.completedReadOnlyToolCount,
                  explicitCiLogRequest: false,
                  encounteredCiLogsAuthorizationBoundary: false,
                  attemptedCiLogsCliFallback: false,
                }),
                model: this.options.input.modelId,
                providerId: this.options.input.providerId,
                runtimeModelId: this.options.input.runtimeModelId,
                providerTransport: this.options.input.providerTransport,
                providerEndpoint: this.options.input.providerEndpoint,
                temperature: 0,
                signal: input.signal,
              },
            );
            try {
              await this.acknowledgeStagedThreadInputs(input);
            } catch (error) {
              await request.catch(() => undefined);
              throw error;
            }
            return await request;
          },
        );
        const response = recovered;
        responseUsage = response.usage;
        responseReasoningSummary = response.reasoningSummary;
        responseParts = response.parts ?? [];
        toolCalls = [];
      } else {
        const response = await this.requestWithProviderRecovery(
          input,
          context,
          async (attemptContext) => {
            const request = this.options.llmGateway.generateText({
              context: attemptContext,
              messages,
              system: buildAgenticLoopSystemPrompt({
                workspaceContext: buildAgenticLoopWorkspaceContext({
                  repositoryContext:
                    readContextRecord(
                      providerContext.metadata,
                      "repositoryContext",
                    ) ?? this.options.input.repositoryContext,
                  prompt: providerContext.instructions,
                  continuation: this.options.workspaceHints?.continuation,
                  workspaceBootstrap:
                    this.options.workspaceHints?.workspaceBootstrap,
                  gitTaskStrategy: this.options.workspaceHints?.gitTaskStrategy,
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
            });
            try {
              await this.acknowledgeStagedThreadInputs(input);
            } catch (error) {
              await request.catch(() => undefined);
              throw error;
            }
            return await request;
          },
        );
        responseUsage = response.usage;
        responseReasoningSummary = response.reasoningSummary;
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

      if (finalRecovery && !visibleText.trim()) {
        throw new Error(
          "[runtime-kernel/native] Provider returned an empty final answer during synthesis recovery",
        );
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
        ...(responseReasoningSummary
          ? { reasoning: responseReasoningSummary }
          : {}),
        usage: toUsageSnapshot(
          responseUsage,
          input,
          this.addUsage(responseUsage),
        ),
      };
    }
    const commentary = resolveModelCommentary(visibleText);
    if (commentary) {
      await this.options.legacyObserver?.recordMessageEmitted(
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
      await this.options.legacyObserver?.recordToolRequested({
        id: protocolToolCallId,
        type: toolCall.toolName,
        input: toolCall.args,
      });
    }
    this.pendingToolCalls.push(...toolCalls);
    this.pendingToolCallBatchId = ToolCallBatchIdSchema.parse(
      toProtocolId("batch", `${this.options.runId}-${this.stepsExecuted}`),
    );
    this.pendingCommentary = commentary;
    this.pendingReasoningSummary = responseReasoningSummary;
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
    publicMessage: string,
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
      detail: publicMessage,
    });
  }

  recordTerminalError(error: unknown): void {
    this.failedToolCount += 1;
    this.stopReason = "tool_error";
    const detail = buildNativeKernelTerminalMessage(error, resolveNativeKernelTerminalState(error));
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
    await this.options.modelStepObserver?.started({
      turnId: input.turn.id,
      step: this.stepsExecuted + 1,
      requiresMutation: this.requiresMutation,
    });
    console.log(
      formatRuntimeDiagnosticLogLine(
        "runtime-kernel/native",
        "model-step-started",
        {
          runId: this.options.runId,
          sessionId: this.options.conversationId,
          step: this.stepsExecuted + 1,
          requiresMutation: this.requiresMutation,
        },
      ),
    );
  }

  private async recordModelStepCompleted(
    input: ProviderCallInput,
  ): Promise<void> {
    await this.options.modelStepObserver?.completed({
      turnId: input.turn.id,
      step: this.stepsExecuted,
      requiresMutation: this.requiresMutation,
    });
    console.log(
      formatRuntimeDiagnosticLogLine(
        "runtime-kernel/native",
        "model-step-completed",
        {
          runId: this.options.runId,
          sessionId: this.options.conversationId,
          step: this.stepsExecuted,
        },
      ),
    );
  }

  private async requestWithProviderRecovery<T>(
    input: ProviderCallInput,
    context: NativeProviderCallContext,
    operation: (context: NativeProviderCallContext) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await runWithProviderRequestRecovery(
        (retryCount) =>
          runWithNativeCancellationPolling(
            operation({
              ...context,
              idempotencyKey: buildProviderRecoveryIdempotencyKey(
                context.idempotencyKey,
                retryCount,
              ),
            }),
            this.options.isRunCancelled,
          ),
        {
          signal: input.signal,
          onRetry: async (delayMs, retryCount, reason) => {
            const progress = buildProviderRecoveryProgress({
              delayMs,
              retryCount,
              reason,
              turnId: input.turn.id,
            });
            await this.options.legacyObserver?.recordRunProgress(
              RUN_WORKFLOW_STEPS.EXECUTION,
              progress.title,
              progress.detail,
              "active",
              {
                displayMode: "visible",
                metadata: {
                  owner: "runtime-kernel-native",
                  ...progress.metadata,
                },
              },
            );
          },
        },
      );
      if (result.retryCount > 0) {
        await this.options.legacyObserver?.recordRunProgress(
          RUN_WORKFLOW_STEPS.EXECUTION,
          "Provider retry",
          "The provider retry window ended and model execution resumed.",
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
    const callBatchId = this.pendingToolCallBatchId;
    if (this.pendingToolCalls.length === 0) this.pendingToolCallBatchId = null;
    const commentary = this.pendingCommentary;
    this.pendingCommentary = null;
    const reasoning = this.pendingReasoningSummary;
    this.pendingReasoningSummary = undefined;
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
        ...(callBatchId ? { callBatchId } : {}),
      }),
      ...(commentary ? { commentary } : {}),
      ...(reasoning ? { reasoning } : {}),
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

export type KernelAgenticProviderOptions = ConstructorParameters<
  typeof KernelAgenticProvider
>[0];
export type NativeProviderToolTracker = Pick<
  KernelAgenticProvider,
  "recordToolStarted" | "recordToolCompleted" | "recordToolFailed"
>;
