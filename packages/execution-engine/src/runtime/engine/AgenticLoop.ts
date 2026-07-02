/**
 * AgenticLoop - Bounded agentic tool-chaining loop
 *
 * Implements Track 3: Bounded Agentic Loop
 * Executes tools inline and feeds results back to LLM for further action
 */

import type { CoreMessage, CoreTool } from "ai";
import type { ProviderModelTransport } from "@repo/shared-types";
import {
  safeParseToolActivityMetadata,
  type ToolActivityMetadata,
} from "@repo/shared-types";
import {
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../cost/index.js";
import {
  LLMUnusableResponseError,
  type ILLMGateway,
  type LLMTextResponse,
} from "../llm/index.js";
import type { IBudgetManager } from "../cost/index.js";
import type { TaskExecutor } from "../orchestration/index.js";
import { isMutatingCodingToolId } from "../tools/CodingToolRegistry.js";
import { formatRuntimeDiagnosticLogLine } from "../lib/RuntimeDiagnosticLog.js";
import { Task } from "../task/index.js";
import type {
  AgenticLoopTerminalLlmIssue,
  AgenticLoopToolLifecycleEvent,
  TaskResult,
} from "../types.js";
import {
  GitToolFailureClassifier,
  shouldClassifyAsGitOrShellFailure,
} from "./GitToolFailureClassifier.js";
import {
  buildCorrectionHintText,
  buildInvalidToolInputError,
  buildRuntimeCapabilityPromptSection,
  buildUnavailableToolError,
  createCloudSandboxRunCapabilityManifest,
  serializeStructuredToolError,
  type RunCapabilityManifest,
  type StructuredToolError,
} from "../capabilities/index.js";
import {
  classifyCurrentTurnIntentFromMessages,
  requiresMutationForIntent,
  type CurrentTurnIntent,
} from "./RunCurrentTurnIntent.js";
import { PermissionGateError } from "./PermissionGateError.js";

export interface AgenticLoopConfig {
  maxSteps: number;
  runId: string;
  sessionId: string;
  budget?: IBudgetManager;
  executionNonce?: string;
}

export interface AgenticLoopToolCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AgenticLoopToolResult {
  toolId: string;
  toolName: string;
  result: unknown;
  error?: string;
  terminalError?: boolean;
}

export interface AgenticLoopProviderRetryEvent {
  providerId: string;
  modelId: string;
  anomalyCode: string;
  finishReason?: string;
  statusCode?: number;
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  retryCount: number;
}

export type StopReason =
  | "max_steps_reached"
  | "budget_exceeded"
  | "llm_stop"
  | "tool_error"
  | "cancelled";

export interface AgenticLoopResult {
  stopReason: StopReason;
  messages: CoreMessage[];
  toolExecutionCount: number;
  failedToolCount: number;
  stepsExecuted: number;
  requiresMutation: boolean;
  currentTurnIntent?: CurrentTurnIntent;
  completedMutatingToolCount: number;
  completedReadOnlyToolCount: number;
  llmRetryCount?: number;
  terminalLlmIssue?: AgenticLoopTerminalLlmIssue;
  toolLifecycle: AgenticLoopToolLifecycleEvent[];
}

export interface AgenticLoopHooks {
  workspaceContext?: string;
  executeTool?: (toolCall: AgenticLoopToolCall) => Promise<TaskResult>;
  onAssistantMessage?: (content: string) => Promise<void>;
  isRunCancelled?: () => Promise<boolean>;
  onProgress?: (
    progress: {
      phase: "planning" | "execution" | "synthesis";
      label: string;
      summary: string;
      status: "active" | "completed";
    } | null,
  ) => Promise<void>;
  onToolRequested?: (toolCall: AgenticLoopToolCall) => Promise<void>;
  onToolStarted?: (toolCall: AgenticLoopToolCall) => Promise<void>;
  onToolCompleted?: (
    toolCall: AgenticLoopToolCall,
    result: unknown,
    executionTimeMs: number,
  ) => Promise<void>;
  onToolFailed?: (
    toolCall: AgenticLoopToolCall,
    error: string,
    executionTimeMs: number,
  ) => Promise<void>;
  onProviderRetry?: (event: AgenticLoopProviderRetryEvent) => Promise<void>;
}

export class AgenticLoopCancelledError extends Error {
  constructor(message = "Run was cancelled") {
    super(message);
    this.name = "AgenticLoopCancelledError";
  }
}

const gitToolFailureClassifier = new GitToolFailureClassifier();

/**
 * AgenticLoop executes a bounded loop of LLM calls and tool execution
 * with explicit stop conditions and budget enforcement
 */
export class AgenticLoop {
  private readonly config: AgenticLoopConfig;
  private readonly llmGateway: ILLMGateway;
  private readonly executor: TaskExecutor;
  private stepsExecuted: number = 0;
  private toolExecutionCount: number = 0;
  private failedToolCount: number = 0;
  private completedMutatingToolCount: number = 0;
  private completedReadOnlyToolCount: number = 0;
  private llmRetryCount: number = 0;
  private terminalLlmIssue?: AgenticLoopTerminalLlmIssue;
  private toolLifecycle: AgenticLoopToolLifecycleEvent[] = [];
  private completedReadOnlyToolFingerprints = new Set<string>();

  constructor(
    config: AgenticLoopConfig,
    llmGateway: ILLMGateway,
    executor: TaskExecutor,
  ) {
    if (config.maxSteps < 1) {
      throw new Error("maxSteps must be >= 1");
    }
    this.config = config;
    this.llmGateway = llmGateway;
    this.executor = executor;
  }

  /**
   * Execute the agentic loop
   * Returns result with explicit stop reason
   */
  async execute(
    initialMessages: CoreMessage[],
    tools: Record<string, CoreTool>,
    context: {
      agentType: string;
      modelId?: string;
      providerId?: string;
      runtimeModelId?: string;
      providerTransport?: ProviderModelTransport;
      providerEndpoint?: string;
      temperature?: number;
    } & AgenticLoopHooks,
  ): Promise<AgenticLoopResult> {
    this.reset();
    const messages: CoreMessage[] = [...initialMessages];
    const currentTurnIntent =
      classifyCurrentTurnIntentFromMessages(initialMessages);
    const requiresMutation = requiresMutationForIntent(currentTurnIntent);
    const latestTurnExplicitCiLogRequest =
      latestTurnRequestsCiLogs(initialMessages);
    const capabilityManifest = createCloudSandboxRunCapabilityManifest({
      runId: this.config.runId,
      availableToolIds: Object.keys(tools),
      providerId: context.providerId,
      modelId: context.runtimeModelId ?? context.modelId,
    });
    let encounteredCiLogsAuthorizationBoundary = false;
    let attemptedCiLogsCliFallback = false;
    let latestCorrectionHint: string | undefined;
    let stopReason: StopReason | null = null;

    for (let step = 0; step < this.config.maxSteps; step++) {
      this.stepsExecuted = step + 1;
      const isFinalSynthesisStep =
        step === this.config.maxSteps - 1 && this.toolExecutionCount > 0;

      if (await isCancellationRequested(context)) {
        stopReason = "cancelled";
        break;
      }

      // Check budget before LLM call
      try {
        if (await this.isRunOverBudget()) {
          throw new BudgetExceededError(this.config.runId, 0, 0);
        }
      } catch (error) {
        if (
          error instanceof BudgetExceededError ||
          error instanceof SessionBudgetExceededError
        ) {
          console.warn(
            `[agentic-loop] Budget exceeded at step ${step} for run ${this.config.runId}`,
          );
          stopReason = "budget_exceeded";
          break;
        }
        throw error;
      }

      console.log(
        `[agentic-loop] Step ${step + 1}/${this.config.maxSteps} for run ${this.config.runId}`,
      );

      const progress = buildLoopProgressUpdate({
        isFinalSynthesisStep,
      });
      if (progress) {
        await context.onProgress?.(progress);
      }

      // Call LLM with tool definitions for this step.
      let response: LLMTextResponse | null = null;
      const llmCallStartedAt = Date.now();
      const requestToolCount = isFinalSynthesisStep
        ? 0
        : Object.keys(tools).length;
      console.log(
        formatRuntimeDiagnosticLogLine("agentic-loop/model", "started", {
          runId: this.config.runId,
          sessionId: this.config.sessionId,
          step: step + 1,
          maxSteps: this.config.maxSteps,
          providerId: context.providerId ?? null,
          modelId: context.runtimeModelId ?? context.modelId ?? null,
          finalSynthesisStep: isFinalSynthesisStep,
          messageCount: messages.length,
          messageRoles: summarizeMessageRoles(messages),
          toolDefinitionCount: requestToolCount,
        }),
      );
      try {
        response = await runWithCancellationPolling(
          this.generateLoopText(
            {
              context: {
                runId: this.config.runId,
                sessionId: this.config.sessionId,
                agentType: context.agentType,
                phase: "task",
              },
              messages,
              system: buildAgenticLoopSystemPrompt({
                workspaceContext: context.workspaceContext,
                finalSynthesisOnly: isFinalSynthesisStep,
                requiresMutation,
                completedMutatingToolCount: this.completedMutatingToolCount,
                completedReadOnlyToolCount: this.completedReadOnlyToolCount,
                explicitCiLogRequest: latestTurnExplicitCiLogRequest,
                encounteredCiLogsAuthorizationBoundary,
                attemptedCiLogsCliFallback,
                capabilityManifest,
                latestCorrectionHint,
              }),
              tools: isFinalSynthesisStep ? undefined : tools,
              model: context.modelId,
              providerId: context.providerId,
              runtimeModelId: context.runtimeModelId,
              providerTransport: context.providerTransport,
              providerEndpoint: context.providerEndpoint,
              temperature: context.temperature,
            },
            step,
            context,
          ),
          context,
        );
      } catch (error) {
        if (error instanceof AgenticLoopCancelledError) {
          stopReason = "cancelled";
        } else {
          console.error(
            formatRuntimeDiagnosticLogLine("agentic-loop/model", "failed", {
              runId: this.config.runId,
              sessionId: this.config.sessionId,
              step: step + 1,
              elapsedMs: Date.now() - llmCallStartedAt,
              providerId: context.providerId ?? null,
              modelId: context.runtimeModelId ?? context.modelId ?? null,
              errorName: error instanceof Error ? error.name : "UnknownError",
              errorMessage: boundLogText(
                error instanceof Error ? error.message : String(error),
              ),
            }),
          );
          throw error;
        }
      }

      if (stopReason === "cancelled" || response === null) {
        break;
      }

      const responseText =
        typeof response.text === "string" ? response.text : "";
      console.log(
        formatRuntimeDiagnosticLogLine("agentic-loop/model", "completed", {
          runId: this.config.runId,
          sessionId: this.config.sessionId,
          step: step + 1,
          elapsedMs: Date.now() - llmCallStartedAt,
          responseChars: responseText.length,
          toolCallCount: response.toolCalls?.length ?? 0,
          toolCalls: summarizeToolCalls(response.toolCalls ?? []),
        }),
      );

      // Add LLM response to messages
      messages.push(buildAssistantMessage(responseText, response.toolCalls));
      if (response.toolCalls && response.toolCalls.length > 0) {
        await context.onAssistantMessage?.(responseText);
      }

      // Check if LLM requested tool calls
      if (!response.toolCalls || response.toolCalls.length === 0) {
        console.log(
          `[agentic-loop] LLM finished (no tool calls) at step ${step}`,
        );
        stopReason = "llm_stop";
        break;
      }

      // Execute requested tools
      const toolResults: AgenticLoopToolResult[] = [];

      for (const toolCall of response.toolCalls) {
        this.toolExecutionCount++;
        this.recordToolLifecycle(toolCall, "requested");
        await context.onToolRequested?.(toolCall);
        if (isCiLogsCliFallbackToolCall(toolCall)) {
          attemptedCiLogsCliFallback = true;
        }

        if (await isCancellationRequested(context)) {
          stopReason = "cancelled";
          break;
        }

        const duplicateToolCallMessage =
          this.getDuplicateReadOnlyToolCallMessage(toolCall);
        if (duplicateToolCallMessage) {
          this.failedToolCount++;
          this.recordToolLifecycle(
            toolCall,
            "failed",
            duplicateToolCallMessage,
          );
          await context.onToolFailed?.(toolCall, duplicateToolCallMessage, 0);
          toolResults.push({
            toolId: toolCall.id,
            toolName: toolCall.toolName,
            result: null,
            error: duplicateToolCallMessage,
            terminalError: false,
          });
          continue;
        }

        // Check budget before tool execution
        try {
          if (await this.isRunOverBudget()) {
            throw new BudgetExceededError(this.config.runId, 0, 0);
          }
        } catch (error) {
          if (
            error instanceof BudgetExceededError ||
            error instanceof SessionBudgetExceededError
          ) {
            console.warn(
              `[agentic-loop] Budget exceeded during tool execution for run ${this.config.runId}`,
            );
            stopReason = "budget_exceeded";
            break;
          }
          throw error;
        }

        // Execute tool
        try {
          if (!tools[toolCall.toolName]) {
            this.failedToolCount++;
            const structuredError = buildUnavailableToolError({
              attemptedTool: toolCall.toolName,
              manifest: capabilityManifest,
            });
            const message = serializeStructuredToolError(structuredError);
            latestCorrectionHint = buildCorrectionHintText(structuredError);
            const recoverable =
              structuredError.availableAlternatives.length > 0;
            console.warn(`[agentic-loop] ${message} (call: ${toolCall.id})`);
            this.recordToolLifecycle(toolCall, "failed", message);
            await context.onToolFailed?.(toolCall, message, 0);
            toolResults.push({
              toolId: toolCall.id,
              toolName: toolCall.toolName,
              result: null,
              error: message,
              terminalError: !recoverable,
            });
            continue;
          }

          console.log(
            formatRuntimeDiagnosticLogLine("agentic-loop/tool", "started", {
              runId: this.config.runId,
              sessionId: this.config.sessionId,
              step: step + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.toolName,
              argKeys: Object.keys(toolCall.args).sort(),
            }),
          );

          const toolStartedAt = Date.now();
          this.recordToolLifecycle(toolCall, "started");
          await context.onToolStarted?.(toolCall);
          const result = context.executeTool
            ? await context.executeTool(toolCall)
            : await this.executor.execute(
                this.createToolTask(toolCall.id, toolCall),
              );
          const executionTimeMs = Date.now() - toolStartedAt;
          console.log(
            formatRuntimeDiagnosticLogLine("agentic-loop/tool", "finished", {
              runId: this.config.runId,
              sessionId: this.config.sessionId,
              step: step + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.toolName,
              resultStatus: result.status,
              elapsedMs: executionTimeMs,
              outputChars: readToolOutputLength(result),
              errorCode: result.error?.code ?? null,
              errorMessage: result.error?.message
                ? boundLogText(result.error.message)
                : null,
            }),
          );

          if (result.status === "DONE") {
            if (isMutatingCodingToolId(toolCall.toolName)) {
              this.completedMutatingToolCount++;
            } else {
              this.completedReadOnlyToolCount++;
              this.completedReadOnlyToolFingerprints.add(
                buildReadOnlyToolFingerprint(toolCall),
              );
            }
            this.recordToolLifecycle(
              toolCall,
              "completed",
              summarizeLifecycleDetail(result.output?.content ?? null),
              extractToolActivityMetadata(result.output?.metadata),
            );
            await context.onToolCompleted?.(
              toolCall,
              result.output ?? null,
              executionTimeMs,
            );
            toolResults.push({
              toolId: toolCall.id,
              toolName: toolCall.toolName,
              result: result.output ?? null,
            });
          } else {
            this.failedToolCount++;
            const toolError = result.error?.message || "Tool execution failed";
            if (
              isCiLogsAuthorizationBoundaryFailure(toolCall.toolName, toolError)
            ) {
              encounteredCiLogsAuthorizationBoundary = true;
            }
            const activityMetadata = extractToolActivityMetadata(
              result.output?.metadata,
            );
            this.recordToolLifecycle(
              toolCall,
              "failed",
              toolError,
              activityMetadata,
            );
            await context.onToolFailed?.(toolCall, toolError, executionTimeMs);
            toolResults.push({
              toolId: toolCall.id,
              toolName: toolCall.toolName,
              result: null,
              error: toolError,
              terminalError: isTerminalToolFailure({
                toolName: toolCall.toolName,
                error: toolError,
                metadata: activityMetadata,
              }),
            });
          }
        } catch (error) {
          if (error instanceof AgenticLoopCancelledError) {
            stopReason = "cancelled";
            break;
          }
          this.failedToolCount++;
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          const structuredError = buildStructuredToolFailureError({
            toolName: toolCall.toolName,
            errorMessage,
            manifest: capabilityManifest,
          });
          const toolErrorMessage = structuredError
            ? serializeStructuredToolError(structuredError)
            : errorMessage;
          if (structuredError) {
            latestCorrectionHint = buildCorrectionHintText(structuredError);
          }
          if (
            isCiLogsAuthorizationBoundaryFailure(
              toolCall.toolName,
              toolErrorMessage,
            )
          ) {
            encounteredCiLogsAuthorizationBoundary = true;
          }
          const executionTimeMs = 0;
          this.recordToolLifecycle(toolCall, "failed", toolErrorMessage);
          await context.onToolFailed?.(
            toolCall,
            toolErrorMessage,
            executionTimeMs,
          );
          const permissionGate =
            error instanceof PermissionGateError ? error.gateResult.kind : null;
          const logLine = formatRuntimeDiagnosticLogLine(
            "agentic-loop/tool",
            "failed",
            {
              runId: this.config.runId,
              sessionId: this.config.sessionId,
              step: step + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.toolName,
              status:
                permissionGate === "ask"
                  ? "permission_gated"
                  : permissionGate === "deny"
                    ? "permission_denied"
                    : "threw",
              errorName: error instanceof Error ? error.name : "UnknownError",
              errorMessage: boundLogText(errorMessage),
            },
          );
          if (permissionGate) {
            console.warn(logLine);
          } else {
            console.error(logLine);
          }
          toolResults.push({
            toolId: toolCall.id,
            toolName: toolCall.toolName,
            result: null,
            error: toolErrorMessage,
            terminalError: isTerminalToolFailure({
              toolName: toolCall.toolName,
              error: toolErrorMessage,
            }),
          });
        }
      }

      // If budget exceeded during tool execution, stop loop
      if (stopReason === "budget_exceeded") {
        break;
      }

      if (stopReason === "cancelled") {
        break;
      }

      // Add tool results to messages for next LLM call
      if (toolResults.length > 0) {
        messages.push(buildToolResultMessage(toolResults));
      }

      if (toolResults.some((result) => result.terminalError)) {
        stopReason = "tool_error";
        break;
      }
    }

    if (!stopReason) {
      console.log(
        `[agentic-loop] Max steps reached (${this.config.maxSteps}) for run ${this.config.runId}`,
      );
      stopReason = "max_steps_reached";
    }

    console.log(
      `[agentic-loop] Finished for run ${this.config.runId}: stopReason=${stopReason}, steps=${this.stepsExecuted}, tools=${this.toolExecutionCount}`,
    );

    return {
      stopReason,
      messages,
      toolExecutionCount: this.toolExecutionCount,
      failedToolCount: this.failedToolCount,
      stepsExecuted: this.stepsExecuted,
      requiresMutation,
      currentTurnIntent,
      completedMutatingToolCount: this.completedMutatingToolCount,
      completedReadOnlyToolCount: this.completedReadOnlyToolCount,
      llmRetryCount: this.llmRetryCount,
      terminalLlmIssue: this.terminalLlmIssue,
      toolLifecycle: [...this.toolLifecycle],
    };
  }

  /**
   * Get current loop statistics
   */
  getStats() {
    return {
      stepsExecuted: this.stepsExecuted,
      toolExecutionCount: this.toolExecutionCount,
      failedToolCount: this.failedToolCount,
      toolLifecycleCount: this.toolLifecycle.length,
      completedMutatingToolCount: this.completedMutatingToolCount,
      completedReadOnlyToolCount: this.completedReadOnlyToolCount,
      llmRetryCount: this.llmRetryCount,
      terminalLlmIssue: this.terminalLlmIssue,
      toolLifecycle: [...this.toolLifecycle],
      maxSteps: this.config.maxSteps,
    };
  }

  /**
   * Reset counters (for testing)
   */
  reset() {
    this.stepsExecuted = 0;
    this.toolExecutionCount = 0;
    this.failedToolCount = 0;
    this.completedMutatingToolCount = 0;
    this.completedReadOnlyToolCount = 0;
    this.llmRetryCount = 0;
    this.terminalLlmIssue = undefined;
    this.toolLifecycle = [];
    this.completedReadOnlyToolFingerprints.clear();
  }

  private async generateLoopText(
    request: Parameters<ILLMGateway["generateText"]>[0],
    step: number,
    hooks: Pick<AgenticLoopHooks, "onProviderRetry">,
  ): ReturnType<ILLMGateway["generateText"]> {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.llmGateway.generateText({
          ...request,
          context: {
            ...request.context,
            idempotencyKey: buildAgenticLoopTextAttemptIdempotencyKey(
              this.config.runId,
              step,
              attempt,
              this.config.executionNonce,
            ),
          },
        });
      } catch (error) {
        if (!(error instanceof LLMUnusableResponseError)) {
          throw error;
        }

        if (attempt >= maxAttempts) {
          this.terminalLlmIssue = {
            type: "unusable_response",
            providerId: error.providerId,
            modelId: error.modelId,
            anomalyCode: error.anomalyCode,
            finishReason: error.finishReason,
            statusCode: error.statusCode,
            attempts: attempt,
          };
          console.warn(
            `[agentic-loop] Unusable LLM response exhausted retry for run ${this.config.runId}`,
            this.terminalLlmIssue,
          );
          throw error;
        }

        this.llmRetryCount++;
        await hooks.onProviderRetry?.({
          providerId: error.providerId,
          modelId: error.modelId,
          anomalyCode: error.anomalyCode,
          finishReason: error.finishReason,
          statusCode: error.statusCode,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          retryCount: this.llmRetryCount,
        });
        console.warn(
          `[agentic-loop] Unusable LLM response for run ${this.config.runId}; retrying once`,
          {
            providerId: error.providerId,
            modelId: error.modelId,
            anomalyCode: error.anomalyCode,
            finishReason: error.finishReason,
            statusCode: error.statusCode,
          },
        );
      }
    }

    throw new Error("[agentic-loop] unreachable LLM retry state");
  }

  private createToolTask(
    id: string,
    toolCall: Pick<AgenticLoopToolCall, "toolName" | "args">,
  ): Task {
    return new Task(id, this.config.runId, toolCall.toolName, "PENDING", [], {
      description: `Execute ${toolCall.toolName}`,
      ...toolCall.args,
    });
  }

  private recordToolLifecycle(
    toolCall: Pick<AgenticLoopToolCall, "id" | "toolName">,
    status: AgenticLoopToolLifecycleEvent["status"],
    detail?: string,
    metadata?: ToolActivityMetadata,
  ): void {
    this.toolLifecycle.push({
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      status,
      mutating: isMutatingCodingToolId(toolCall.toolName),
      recordedAt: new Date().toISOString(),
      detail,
      metadata,
    });
  }

  private async isRunOverBudget(): Promise<boolean> {
    if (!this.config.budget) {
      return false;
    }

    try {
      return await this.config.budget.isOverBudget(this.config.runId);
    } catch (error) {
      if (
        error instanceof BudgetExceededError ||
        error instanceof SessionBudgetExceededError
      ) {
        return true;
      }
      throw error;
    }
  }

  private getDuplicateReadOnlyToolCallMessage(
    toolCall: Pick<AgenticLoopToolCall, "toolName" | "args">,
  ): string | null {
    if (isMutatingCodingToolId(toolCall.toolName)) {
      return null;
    }

    const fingerprint = buildReadOnlyToolFingerprint(toolCall);
    if (!this.completedReadOnlyToolFingerprints.has(fingerprint)) {
      return null;
    }

    return `Skipped duplicate ${toolCall.toolName} call because the same request already completed in this run. Choose a different tool or proceed with the edit.`;
  }
}

export function buildAgenticLoopSystemPrompt(input: {
  workspaceContext?: string;
  finalSynthesisOnly: boolean;
  requiresMutation: boolean;
  completedMutatingToolCount: number;
  completedReadOnlyToolCount: number;
  explicitCiLogRequest: boolean;
  encounteredCiLogsAuthorizationBoundary: boolean;
  attemptedCiLogsCliFallback: boolean;
  capabilityManifest?: RunCapabilityManifest;
  latestCorrectionHint?: string;
}): string {
  const sections = [
    "You are LegionCode's autonomous build agent.",
    "Your job is to inspect the real workspace, decide which tools to use, and answer the user's request in clear natural language.",
    "Start with the real workspace before concluding anything. Never invent file contents, project structure, git state, or completed work.",
    "Tool strategy:",
    "- Prefer typed git tools for repository work (status, diff, branch, stage, commit, push, PR) to keep actions structured and auditable.",
    "- Use shell/bash for git only when the required step is not covered by typed git tools, or when the user explicitly asks for a shell command.",
    "- Never run git config user.name or git config user.email through bash during agent flow. For commit identity issues, use git_commit with authorName and authorEmail (or rely on OAuth-backed identity).",
    "- Use GitHub connector read tools for remote metadata (PRs, checks, reviews, issues). Prefer github_pr_list for discovering the current PR by branch, then github_pr_get/github_pr_checks_get/github_review_threads_get.",
    "- For pull-request note/comment requests, use github_cli_pr_comment through the bounded CLI lane instead of raw gh shell commands.",
    "- For CI/debug requests, use github_pr_checks_get to identify failing checks and github_actions_job_logs_get to fetch failing job log tails before proposing fixes.",
    "- If github_actions_job_logs_get returns 401/403, treat it as an authorization boundary and stop retrying the same logs request.",
    "- Prefer github_* connector tools first for GitHub metadata. Use the bounded github_cli_* tools as the parity lane when connector coverage or authorization is insufficient.",
    "- Keep raw gh shell usage discouraged. Do not invoke gh through bash for autonomous GitHub tasks.",
    "- Never ask the user to type internal approval directives or magic command phrases. Ask them to use approval controls, or explain the required approval plainly.",
    "- When a git shell command fails with a normal nonzero exit, inspect the error and choose the next bounded recovery step instead of stopping immediately.",
    "- A clean git status after a failed push or PR step often means the changes were already committed locally. Do not recreate files just because the working tree is clean.",
    "- When staging for a request, detect the changed paths and stage only those specific files. Never stage the whole workspace just to make commit or push succeed.",
    "- If git_push fails because the remote branch is ahead or non-fast-forward, do not rewrite files. Use git_pull to sync with a fast-forward-only pull, then retry git_push. If git_pull cannot fast-forward, stop and explain that manual branch resolution is required.",
    "- For repository or git status questions without a specific command, use git_status before answering.",
    "- For PR-targeted edits, resolve the PR head branch and switch to that branch before any write_file mutation.",
    "- If git_branch_switch reports checkout-overwrite conflicts, do not stop. Decide the next bounded recovery step (for example commit or stash on the current branch, then retry switching).",
    "- For vague component, page, route, or file questions, discover with list_files, glob, or grep before read_file.",
    "- Prefer narrowing search after one broad listing. Do not repeat the same missing path after a file-not-found error.",
    "- If a non-mutating tool returns no match or not found, keep exploring with different tools or paths instead of stopping.",
    "- If a file-edit mutation tool fails, stop and explain what failed.",
    "- git_commit messages must be a single-line conventional commit subject (for example: feat: add hero carousel).",
    "Answer quality:",
    "- After gathering enough evidence, answer the user directly in plain English.",
    "- Summarize tool results instead of echoing raw JSON or raw telemetry.",
    "- Reference the files or git facts you actually observed.",
    "- Do not narrate internal self-talk, speculation loops, or hidden deliberation.",
  ];

  if (input.capabilityManifest) {
    sections.push(
      buildRuntimeCapabilityPromptSection(input.capabilityManifest),
    );
  }

  if (input.latestCorrectionHint) {
    sections.push(`Tool correction hint:\n${input.latestCorrectionHint}`);
  }

  if (input.requiresMutation) {
    sections.push(
      [
        "Edit-reporting rule:",
        "- If you change files, reference the concrete files or git facts you actually observed.",
        "- If you did not change files, say so plainly and do not claim that files were updated or improved.",
      ].join("\n"),
    );
  }

  if (input.workspaceContext) {
    sections.push(`Workspace context:\n${input.workspaceContext}`);
  }

  if (input.explicitCiLogRequest) {
    sections.push(
      [
        "CI logs request rule:",
        "- The latest user request explicitly asked for CI/check logs from the remote run.",
        "- Stay on remote log retrieval with github_pr_checks_get and github_actions_job_logs_get.",
        "- Do not run or suggest local lint/test commands as a fallback unless the user explicitly asks for a local fallback.",
        "- If logs are blocked by 401/403, report the authorization boundary and required reconnect/permissions step.",
      ].join("\n"),
    );

    if (
      input.encounteredCiLogsAuthorizationBoundary &&
      !input.attemptedCiLogsCliFallback
    ) {
      sections.push(
        [
          "CI logs auth-boundary fallback:",
          "- You already hit a 401/403 on github_actions_job_logs_get in this run.",
          "- Attempt one bounded github_cli_actions_job_logs_get fallback for the same job logs before finalizing.",
          "- If GitHub CLI is unavailable or still unauthorized, stop retrying and clearly report that outcome.",
        ].join("\n"),
      );
    }
  }

  if (input.finalSynthesisOnly) {
    const finalStepRules = [
      "Final step rule:",
      "- This is the final step. Do not call tools.",
      "- Synthesize what you have already learned into the best truthful answer you can.",
      "- If the task is incomplete, say what you checked, what you found, and what remains uncertain.",
    ];

    sections.push(finalStepRules.join("\n"));
  }

  return sections.join("\n");
}

function buildAgenticLoopTextAttemptIdempotencyKey(
  runId: string,
  step: number,
  attempt: number,
  executionNonce?: string,
): string {
  return `agentic-loop:${runId}:${executionNonce ?? "default"}:step:${step + 1}:attempt:${attempt}`;
}

const CANCELLATION_POLL_INTERVAL_MS = 2_000;

async function runWithCancellationPolling<T>(
  operation: Promise<T>,
  context: Pick<AgenticLoopHooks, "isRunCancelled">,
): Promise<T> {
  if (!context.isRunCancelled) {
    return operation;
  }

  let stopPolling = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cancellation = new Promise<never>((_, reject) => {
    const schedulePoll = (): void => {
      timeout = setTimeout(() => {
        void pollCancellation(context, () => stopPolling).catch(reject);
      }, CANCELLATION_POLL_INTERVAL_MS);
    };

    const pollCancellation = async (
      pollContext: Pick<AgenticLoopHooks, "isRunCancelled">,
      shouldStop: () => boolean,
    ): Promise<void> => {
      if (shouldStop()) {
        return;
      }
      if (await isCancellationRequested(pollContext)) {
        throw new AgenticLoopCancelledError();
      }
      if (!shouldStop()) {
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

async function isCancellationRequested(
  context: Pick<AgenticLoopHooks, "isRunCancelled">,
): Promise<boolean> {
  return (await context.isRunCancelled?.()) ?? false;
}

function buildReadOnlyToolFingerprint(
  toolCall: Pick<AgenticLoopToolCall, "toolName" | "args">,
): string {
  return `${toolCall.toolName}:${stableSerialize(toolCall.args)}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isTerminalToolFailure(input: {
  toolName: string;
  error: string;
  metadata?: ToolActivityMetadata;
}): boolean {
  if (shouldClassifyAsGitOrShellFailure(input)) {
    return gitToolFailureClassifier.classify({
      toolName: input.toolName,
      message: input.error,
      metadata: input.metadata,
    }).terminal;
  }

  return isMutatingCodingToolId(input.toolName);
}

function buildStructuredToolFailureError(input: {
  toolName: string;
  errorMessage: string;
  manifest: RunCapabilityManifest;
}): StructuredToolError | null {
  if (!isValidationFailure(input.errorMessage, input.toolName)) {
    return null;
  }
  return buildInvalidToolInputError({
    attemptedTool: input.toolName,
    validationMessage: input.errorMessage,
    manifest: input.manifest,
  });
}

function isValidationFailure(message: string, toolName: string): boolean {
  return message.startsWith(`Invalid ${toolName} input.`);
}

export function buildAssistantMessage(
  text: string,
  toolCalls: AgenticLoopToolCall[] | undefined,
): CoreMessage {
  const normalizedText = normalizeAssistantText(text, toolCalls);
  if (!toolCalls || toolCalls.length === 0) {
    return {
      role: "assistant",
      content: normalizedText,
    };
  }

  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }
  > = [];

  if (normalizedText.trim()) {
    content.push({
      type: "text",
      text: normalizedText,
    });
  }

  for (const toolCall of toolCalls) {
    content.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      args: toolCall.args,
    });
  }

  return {
    role: "assistant",
    content,
  };
}

export function buildToolResultMessage(
  toolResults: AgenticLoopToolResult[],
): CoreMessage {
  return {
    role: "tool",
    content: toolResults.map((result) => ({
      type: "tool-result" as const,
      toolCallId: result.toolId,
      toolName: result.toolName,
      result: result.error ? { error: result.error } : result.result,
      isError: Boolean(result.error),
    })),
  };
}

function summarizeLifecycleDetail(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const raw =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }

  const compact = normalized.replace(/\s+/g, " ");
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
}

function extractToolActivityMetadata(
  metadata: unknown,
): ToolActivityMetadata | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const activity = (metadata as Record<string, unknown>).activity;
  const parsed = safeParseToolActivityMetadata(activity);
  return parsed.success ? parsed.data : undefined;
}

function summarizeMessageRoles(messages: CoreMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([role, count]) => `${role}:${count}`)
    .join(",");
}

function summarizeToolCalls(toolCalls: AgenticLoopToolCall[]): string {
  return toolCalls
    .map(
      (toolCall) =>
        `${toolCall.toolName}:${toolCall.id}:${Object.keys(toolCall.args).sort().join("|")}`,
    )
    .join(",");
}

function readToolOutputLength(result: TaskResult): number {
  return result.output?.content.length ?? 0;
}

function boundLogText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function latestTurnRequestsCiLogs(initialMessages: CoreMessage[]): boolean {
  const latestUserMessage = [...initialMessages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage) {
    return false;
  }

  const latestTurnText = extractTextParts(
    latestUserMessage.content,
  ).toLowerCase();

  const asksForLogs = /\b(log|logs)\b/.test(latestTurnText);
  const asksForCiContext =
    /\b(ci|check|checks|workflow|actions|job|run)\b/.test(latestTurnText);
  return asksForLogs && asksForCiContext;
}

function isCiLogsAuthorizationBoundaryFailure(
  toolName: string,
  errorMessage: string,
): boolean {
  if (toolName !== "github_actions_job_logs_get") {
    return false;
  }

  return /\b(401|403)\b|unauthori[sz]ed|additional authorization|actions read access/i.test(
    errorMessage,
  );
}

function isCiLogsCliFallbackToolCall(toolCall: AgenticLoopToolCall): boolean {
  return toolCall.toolName === "github_cli_actions_job_logs_get";
}

function extractTextParts(content: CoreMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function normalizeAssistantText(
  text: string,
  toolCalls: AgenticLoopToolCall[] | undefined,
): string {
  const trimmed = text.trim();
  if (!toolCalls || toolCalls.length === 0 || !trimmed) {
    return normalizeStandaloneToolCallMarkup(text);
  }

  return normalizeStandaloneToolCallMarkup(text);
}

function normalizeStandaloneToolCallMarkup(text: string): string {
  const trimmed = text.trim();
  if (/^<tool_call>[\s\S]*<\/tool_call>$/i.test(trimmed)) {
    return "";
  }

  return text;
}

function buildLoopProgressUpdate(input: { isFinalSynthesisStep: boolean }): {
  phase: "planning" | "execution" | "synthesis";
  label: string;
  summary: string;
  status: "active" | "completed";
} | null {
  if (input.isFinalSynthesisStep) {
    return null;
  }

  return {
    phase: "execution",
    label: "Thinking",
    summary: "",
    status: "active",
  };
}
