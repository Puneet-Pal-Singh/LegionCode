/**
 * HandleChatRequest Use-Case
 * Single Responsibility: Orchestrate chat request processing
 *
 * Handles:
 * - Request validation
 * - Service orchestration
 * - Error handling
 * - Logging
 *
 * Does NOT handle:
 * - HTTP-specific concerns (headers, status codes, response formatting)
 * - RunEngine durable object interaction (passed to caller)
 */

import type { CoreMessage } from "ai";
import {
  DEFAULT_RUN_MODE,
  type BYOKModelPricing,
  type BYOKModelCapability,
  type ProductMode,
  type RunMode,
  type WorkflowEntrypoint,
  type WorkflowIntent,
  type ReasoningEffort,
  type ProviderModelRuntimeRoute,
  type ProviderModelTransport,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import type { TurnScopeBootstrap } from "@repo/platform-protocol";
import { ValidationError } from "../../domain/errors";
import { formatDiagnosticLogLine } from "../../lib/diagnostic-log";
import { PersistenceService } from "../../services/PersistenceService";
import { type BackgroundTaskOwner } from "../../services/thread-titles";
import type { SerializableToolDefinition } from "../../types/tools";
import type {
  AgentType,
  RepositoryContext,
} from "@legioncode/execution-engine/runtime";
import { DurableConversationContextAssembler } from "../../services/chat/DurableConversationContextAssembler";
import {
  builtinProviderRegistry,
  resolveProviderRuntimeRoute,
  type ResolvedProviderRuntimeRoute,
} from "@repo/provider-core";

import type { RunRecord } from "@repo/persistence";
import { scheduleInitialThreadTitle } from "../../services/thread-titles/InitialThreadTitleScheduler";

type RuntimeHarnessId = "cloudflare-sandbox" | "local-sandbox";
type RuntimeOrchestratorBackend = "execution-engine-v1" | "cloudflare_agents";
type RuntimeExecutionBackend = "cloudflare_sandbox" | "e2b" | "daytona";
type RuntimeHarnessMode = "platform_owned" | "delegated";
type RuntimeAuthMode = "api_key" | "oauth";

export interface HandleChatRequestInput {
  sessionId: string;
  runId: string;
  userId?: string;
  workspaceId?: string;
  correlationId: string;
  agentType: AgentType;
  mode?: RunMode;
  prompt: string;
  messages: CoreMessage[];
  providerId?: string;
  modelId?: string;
  harnessId?: RuntimeHarnessId;
  orchestratorBackend?: RuntimeOrchestratorBackend;
  executionBackend?: RuntimeExecutionBackend;
  harnessMode?: RuntimeHarnessMode;
  authMode?: RuntimeAuthMode;
  productMode?: ProductMode;
  workflowIntent?: WorkflowIntent;
  workflowEntrypoint?: WorkflowEntrypoint;
  taskId?: string;
  // Phase 4: Repository context for workspace-aware operations
  repositoryOwner?: string;
  repositoryName?: string;
  repositoryBranch?: string;
  repositoryBaseUrl?: string;
  contextWindowTokens?: number;
  pricing?: BYOKModelPricing;
  reasoningEffort?: ReasoningEffort;
  tools?: Record<string, SerializableToolDefinition>;
  providerRuntimeRoute?: ProviderModelRuntimeRoute;
  modelCapabilities?: BYOKModelCapability;
  identity: TurnScopeBootstrap;
  backgroundTaskOwner?: BackgroundTaskOwner;
}

export interface HandleChatRequestOutput {
  success: boolean;
  sessionId: string;
  runId: string;
  correlationId: string;
  executionPayload: {
    runId: string;
    userId?: string;
    workspaceId?: string;
    sessionId: string;
    correlationId: string;
    requestOrigin?: string;
    input: {
      mode: RunMode;
      agentType: AgentType;
      prompt: string;
      sessionId: string;
      providerId?: string;
      modelId?: string;
      runtimeModelId?: string;
      providerTransport?: import("@repo/shared-types").ProviderModelTransport;
      providerEndpoint?: string;
      harnessId?: RuntimeHarnessId;
      orchestratorBackend: RuntimeOrchestratorBackend;
      executionBackend: RuntimeExecutionBackend;
      harnessMode: RuntimeHarnessMode;
      authMode: RuntimeAuthMode;
      metadata?: Record<string, unknown>;
      repositoryContext?: RepositoryContext;
    };
    messages: CoreMessage[];
    tools?: Record<string, SerializableToolDefinition>;
    identity: TurnScopeBootstrap;
  };
}

/**
 * HandleChatRequest use-case
 */
export class HandleChatRequest {
  private persistenceService: PersistenceService;

  constructor(private env: Env) {
    this.persistenceService = new PersistenceService(env);
  }

  /**
   * Execute the chat request handling use-case
   *
   * @param input - Chat request input
   * @param requestOrigin - HTTP request origin header (for CORS)
   * @returns Execution payload for RunEngine
   * @throws ValidationError if input is invalid
   */
  async execute(
    input: HandleChatRequestInput,
    requestOrigin?: string,
  ): Promise<HandleChatRequestOutput> {
    const {
      sessionId,
      runId,
      userId,
      workspaceId,
      correlationId,
      agentType,
      prompt,
      messages,
      repositoryOwner,
      repositoryName,
      repositoryBranch,
      repositoryBaseUrl,
      identity,
    } = input;

    const runtimeSelections = this.resolveRuntimeSelections(input);
    const mode = input.mode ?? DEFAULT_RUN_MODE;

    try {
      const lastUserMessage = validateSubmittedMessages(
        messages,
        prompt,
        correlationId,
      );

      const repositorySlug =
        repositoryOwner && repositoryName
          ? `${repositoryOwner}/${repositoryName}`
          : undefined;
      const taskId = input.taskId ?? sessionId;
      const contextWindowTokens = resolveContextWindowTokens(input);
      const providerRuntimeRoute =
        input.providerRuntimeRoute ??
        resolveProviderRuntimeRoute(input.providerId, input.modelId);
      const normalizedProviderRuntimeRoute =
        normalizeProviderRuntimeRoute(providerRuntimeRoute);

      let persistedRun: RunRecord | undefined;
      if (!userId) {
        throw new ValidationError(
          "Authenticated ownership is required before turn admission.",
          "TURN_OWNER_REQUIRED",
          correlationId,
        );
      }
      console.log(
        formatDiagnosticLogLine("chat/persistence", "user-message-started", {
          correlationId,
          runId,
          sessionId,
          messageId: readMessageId(lastUserMessage),
          role: lastUserMessage.role,
          messageCount: messages.length,
        }),
      );
      const admittedTurn = await this.persistenceService.admitUserTurn({
        sessionId,
        runId,
        userId,
        workspaceId: identity.workspaceId,
        taskId,
        identity,
        message: lastUserMessage,
        mode,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        branch: repositoryBranch ?? null,
      });
      persistedRun = admittedTurn.run;
      console.log(
        formatDiagnosticLogLine("chat/persistence", "user-message-finished", {
          correlationId,
          runId,
          sessionId,
          messageId: readMessageId(lastUserMessage),
        }),
      );

      if (userId) {
        await scheduleInitialThreadTitle(this.env, this.persistenceService, {
          sessionId,
          userId,
          identity,
          prompt,
          persistedUserMessageId: admittedTurn.id,
          persistedRun,
          providerRuntimeRoute: input.providerRuntimeRoute,
          modelCapabilities: input.modelCapabilities,
          backgroundTaskOwner: input.backgroundTaskOwner,
        });
      }

      const executionMessages = userId
        ? await new DurableConversationContextAssembler(this.env).assemble({
            sessionId,
            userId,
            currentTurnId: identity.turnId,
            revisionOfTurnId: identity.revisionOfTurnId,
          })
        : messages;

      // Build execution payload with repository context
      const executionPayload = {
        runId,
        identity,
        userId,
        workspaceId,
        sessionId,
        correlationId,
        requestOrigin,
        input: {
          mode,
          agentType,
          prompt,
          sessionId,
          providerId: input.providerId,
          modelId: input.modelId,
          ...normalizedProviderRuntimeRoute,
          harnessId: input.harnessId,
          orchestratorBackend: runtimeSelections.orchestratorBackend,
          executionBackend: runtimeSelections.executionBackend,
          harnessMode: runtimeSelections.harnessMode,
          authMode: runtimeSelections.authMode,
          metadata: {
            ...(contextWindowTokens ? { contextWindowTokens } : {}),
            ...(input.pricing ? { pricing: input.pricing } : {}),
            ...(input.reasoningEffort
              ? { reasoningEffort: input.reasoningEffort }
              : {}),
            featureFlags: {
              agenticLoopV1: this.isAgenticLoopEnabled(),
              reviewerPassV1: this.isReviewerPassEnabled(),
              ghCliLaneEnabled: this.isGitHubCliLaneEnabled(),
              ghCliCiEnabled: this.isGitHubCliCiEnabled(),
              ghCliPrCommentEnabled: this.isGitHubCliPrCommentEnabled(),
            },
            ...(input.productMode
              ? {
                  permissionPolicy: {
                    productMode: input.productMode,
                  },
                }
              : {}),
            ...(input.workflowEntrypoint || input.workflowIntent
              ? {
                  workflow: {
                    entrypoint: input.workflowEntrypoint,
                    intent: input.workflowIntent,
                  },
                }
              : {}),
          },
          // Phase 4: Include repository context for workspace-aware operations
          repositoryContext:
            repositoryOwner || repositoryName
              ? {
                  owner: repositoryOwner,
                  repo: repositoryName,
                  branch: repositoryBranch,
                  baseUrl: repositoryBaseUrl,
                }
              : undefined,
        },
        messages: executionMessages,
        tools: input.tools,
      };

      console.log(
        formatDiagnosticLogLine("chat/usecase", "prepared-for-run-engine", {
          correlationId,
          runId,
          sessionId,
          mode,
          providerId: input.providerId ?? null,
          modelId: input.modelId ?? null,
          harnessId: input.harnessId ?? null,
          repository: repositorySlug ?? null,
          branch: repositoryBranch ?? null,
          toolCount: input.tools ? Object.keys(input.tools).length : 0,
          messageCount: messages.length,
        }),
      );

      return {
        success: true,
        sessionId,
        runId,
        correlationId,
        executionPayload,
      };
    } catch (error) {
      console.error(`[chat/usecase] ${correlationId}: Error:`, error);
      throw error;
    }
  }

  private resolveRuntimeSelections(input: HandleChatRequestInput): {
    orchestratorBackend: RuntimeOrchestratorBackend;
    executionBackend: RuntimeExecutionBackend;
    harnessMode: RuntimeHarnessMode;
    authMode: RuntimeAuthMode;
  } {
    return {
      orchestratorBackend: input.orchestratorBackend ?? "execution-engine-v1",
      executionBackend: input.executionBackend ?? "cloudflare_sandbox",
      harnessMode: input.harnessMode ?? "platform_owned",
      authMode: input.authMode ?? "api_key",
    };
  }

  private isReviewerPassEnabled(): boolean {
    const raw = this.env.FEATURE_FLAG_CHAT_REVIEWER_PASS_V1;
    return raw === "1" || raw === "true";
  }

  private isAgenticLoopEnabled(): boolean {
    const raw = this.env.FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1;
    return raw === "1" || raw === "true";
  }

  private isGitHubCliLaneEnabled(): boolean {
    const raw = this.env.FEATURE_FLAG_GH_CLI_LANE_ENABLED;
    return raw === "1" || raw === "true";
  }

  private isGitHubCliCiEnabled(): boolean {
    const raw = this.env.FEATURE_FLAG_GH_CLI_CI_ENABLED;
    return raw === "1" || raw === "true";
  }

  private isGitHubCliPrCommentEnabled(): boolean {
    const raw = this.env.FEATURE_FLAG_GH_CLI_PR_COMMENT_ENABLED;
    return raw === "1" || raw === "true";
  }
}

function normalizeProviderRuntimeRoute(
  route: ProviderModelRuntimeRoute | ResolvedProviderRuntimeRoute | undefined,
): {
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
} {
  if (!route) return {};
  if ("modelId" in route) {
    return {
      runtimeModelId: route.modelId,
      providerTransport: route.transport,
      providerEndpoint: route.endpoint,
    };
  }
  return {
    runtimeModelId: route.runtimeModelId,
    providerTransport: route.providerTransport,
    providerEndpoint: route.providerEndpoint,
  };
}

function readMessageId(message: CoreMessage): string | null {
  const value = (message as Record<string, unknown>).id;
  return typeof value === "string" ? value : null;
}

function validateSubmittedMessages(
  messages: CoreMessage[],
  prompt: string,
  correlationId: string,
): CoreMessage {
  if (!messages || messages.length === 0) {
    throw new ValidationError(
      "No messages provided",
      "NO_MESSAGES",
      correlationId,
    );
  }

  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMessage) {
    throw new ValidationError(
      "No user message found",
      "NO_USER_MESSAGE",
      correlationId,
    );
  }

  if (messages[messages.length - 1] !== lastUserMessage) {
    throw new ValidationError(
      "Latest chat message must be the submitted user prompt",
      "LATEST_MESSAGE_NOT_USER",
      correlationId,
    );
  }

  if (extractMessageText(lastUserMessage.content).trim() !== prompt.trim()) {
    throw new ValidationError(
      "Prompt does not match the latest user message",
      "PROMPT_MESSAGE_MISMATCH",
      correlationId,
    );
  }

  return lastUserMessage;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(extractTextPart).filter(Boolean).join("\n");
  }

  return extractTextPart(content);
}

function extractTextPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }

  if (record.type === "text" && typeof record.content === "string") {
    return record.content;
  }

  return "";
}

function resolveContextWindowTokens(
  input: Pick<
    HandleChatRequestInput,
    "providerId" | "modelId" | "contextWindowTokens"
  >,
): number | undefined {
  if (input.contextWindowTokens) {
    return input.contextWindowTokens;
  }
  if (input.providerId && input.modelId) {
    const catalogLimit = builtinProviderRegistry.getModel(
      input.providerId,
      input.modelId,
    )?.contextWindow;
    if (catalogLimit) {
      return catalogLimit;
    }
  }
  return undefined;
}
