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
  type ProductMode,
  type RunMode,
  type WorkflowEntrypoint,
  type WorkflowIntent,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { ValidationError } from "../../domain/errors";
import { PersistenceService } from "../../services/PersistenceService";
import type { SerializableToolDefinition } from "../../types/tools";
import type {
  AgentType,
  RepositoryContext,
} from "@shadowbox/execution-engine/runtime";

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
  // Phase 4: Repository context for workspace-aware operations
  repositoryOwner?: string;
  repositoryName?: string;
  repositoryBranch?: string;
  repositoryBaseUrl?: string;
  tools?: Record<string, SerializableToolDefinition>;
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
    } = input;

    const runtimeSelections = this.resolveRuntimeSelections(input);
    const mode = input.mode ?? DEFAULT_RUN_MODE;

    try {
      // Validate messages
      if (!messages || messages.length === 0) {
        throw new ValidationError(
          "No messages provided",
          "NO_MESSAGES",
          correlationId,
        );
      }

      // Extract last user message for logging
      const lastUserMessage = messages.filter((m) => m.role === "user").pop();
      if (!lastUserMessage) {
        throw new ValidationError(
          "No user message found",
          "NO_USER_MESSAGE",
          correlationId,
        );
      }

      // Persist user message (side effect)
      try {
        await this.persistenceService.persistUserMessage(
          sessionId,
          runId,
          lastUserMessage,
          {
            userId,
            workspaceId,
            repository:
              repositoryOwner && repositoryName
                ? `${repositoryOwner}/${repositoryName}`
                : undefined,
          },
        );

        // PR6: Ensure run record exists
        if (userId) {
          await this.persistenceService.ensureRun({
            id: runId,
            userId,
            workspaceId: workspaceId ?? null,
            sessionId,
            taskId: sessionId, // For now taskId is same as sessionId if not provided
            mode,
            providerId: input.providerId ?? null,
            modelId: input.modelId ?? null,
            branch: repositoryBranch ?? null,
          });
        }
      } catch (persistError) {
        console.warn(
          `[chat/usecase] ${correlationId}: Failed to persist initial state:`,
          persistError,
        );
        // Don't fail the request if persistence fails
      }

      // Build execution payload with repository context
      const executionPayload = {
        runId,
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
          harnessId: input.harnessId,
          orchestratorBackend: runtimeSelections.orchestratorBackend,
          executionBackend: runtimeSelections.executionBackend,
          harnessMode: runtimeSelections.harnessMode,
          authMode: runtimeSelections.authMode,
          metadata: {
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
        messages,
        tools: input.tools,
      };

      console.log(
        `[chat/usecase] ${correlationId}: Chat request prepared for RunEngine execution`,
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
