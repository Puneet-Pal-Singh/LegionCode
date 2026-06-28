import type { AgentType } from "@shadowbox/execution-engine/runtime";
import {
  ProductModeSchema,
  RunModeSchema,
  WorkflowEntrypointSchema,
  WorkflowIntentSchema,
} from "@repo/shared-types";
import { z } from "zod";
import type { Env } from "../types/ai";
import { HandleChatRequest } from "../application/chat";
import { ChatProviderSelectionSchema } from "../schemas/provider";
import {
  errorResponse,
  jsonResponse,
  withEngineHeaders,
} from "../http/response";
import {
  parseRequestBody,
  validateWithSchema,
} from "../http/validation";
import {
  isDomainError,
  mapDomainErrorToHttp,
} from "../domain/errors";
import {
  extractIdentifiers,
  mapAgentIdToType,
} from "./chat-request-helpers";
import {
  executeViaRunEngineDurableObject,
  extractPromptFromMessages,
  resolveExecutionScope,
  resolveRuntimeTarget,
  type ExecutionScope,
} from "./chat-runtime-helpers";
import { logErrorRateLimited } from "../lib/rate-limited-log";
import { sanitizeUnknownError } from "../core/security/LogSanitizer";
import { errorMessageKey } from "../lib/error-message-key";
import { buildAdmissionScopeFingerprint } from "../services/RunAdmissionScopeFingerprint";
import { RunAdmissionService } from "../services/RunAdmissionService";
import { enforceImageCapability } from "../services/chat/ImageCapabilityGate";
import {
  validateChatImageInput,
  type ChatImageInputState,
} from "../services/chat/ChatImageInputPolicy";
import {
  applySubmittedClientMessageId,
  summarizeCoreMessages,
} from "../services/chat/SubmittedClientMessagePolicy";

const SerializableToolDefinitionSchema = z.object({
  description: z.string().optional(),
  inputSchema: z.object({}).catchall(z.unknown()).optional(),
  parameters: z.object({}).catchall(z.unknown()).optional(),
});

// Zod schema for request body validation
const ChatRequestBodySchema = z.object({
  messages: z.array(z.unknown()).optional(),
  clientMessageId: z.string().trim().min(1).optional(),
  tools: z.record(SerializableToolDefinitionSchema).optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  mode: RunModeSchema.optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  harnessId: z.enum(["cloudflare-sandbox", "local-sandbox"]).optional(),
  orchestratorBackend: z
    .enum(["execution-engine-v1", "cloudflare_agents"])
    .optional(),
  executionBackend: z
    .enum(["cloudflare_sandbox", "e2b", "daytona"])
    .optional(),
  harnessMode: z.enum(["platform_owned", "delegated"]).optional(),
  authMode: z.enum(["api_key", "oauth"]).optional(),
  productMode: ProductModeSchema.optional(),
  workflowIntent: WorkflowIntentSchema.optional(),
  workflowEntrypoint: WorkflowEntrypointSchema.optional(),
  repositoryOwner: z.string().optional(),
  repositoryName: z.string().optional(),
  repositoryBranch: z.string().optional(),
  repositoryBaseUrl: z.string().optional(),
});

type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

interface ChatRequest {
  body: ChatRequestBody;
  correlationId: string;
  sessionId: string;
  runId: string;
  imageInput: ChatImageInputState;
  userId?: string;
  workspaceId?: string;
}

/**
 * ChatController
 * Single Responsibility: validate request and route chat execution through RunEngine.
 */
export class ChatController {
  static async handle(req: Request, env: Env): Promise<Response> {
    const correlationId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    console.log(`[chat/request] ${correlationId} received`);

    try {
      // Parse body and validate against schema
      const rawBody = await parseRequestBody(req, correlationId);
      const body = validateWithSchema<ChatRequestBody>(
        rawBody,
        ChatRequestBodySchema,
        correlationId,
      );
      const identifiers = extractIdentifiers(body, correlationId);

      console.log(
        `[chat/request] ${correlationId} session: ${identifiers.sessionId}, run: ${identifiers.runId}`,
      );
      console.log(
        `[chat/request] ${correlationId} messages: ${body.messages?.length || 0}`,
      );
      console.log(
        `[chat/request] ${correlationId} envelope=${JSON.stringify({
          sessionId: identifiers.sessionId,
          runId: identifiers.runId,
          clientMessageId: body.clientMessageId ?? null,
          providerId: body.providerId ?? null,
          modelId: body.modelId ?? null,
          mode: body.mode ?? null,
          messageCount: body.messages?.length ?? 0,
        })}`,
      );

      // Validate provider/model selection if provided
      validateWithSchema(
        {
          providerId: body.providerId,
          modelId: body.modelId,
        },
        ChatProviderSelectionSchema,
        correlationId,
      );

      const imageInput = validateChatImageInput(body, correlationId);

      const chatRequest: ChatRequest = {
        body,
        correlationId,
        sessionId: identifiers.sessionId,
        runId: identifiers.runId,
        imageInput,
        ...(await resolveExecutionScope(
          req,
          env,
          identifiers.runId,
          correlationId,
        )),
      };

      console.log(`[chat/request] ${correlationId} routing to RunEngine`);
      const response = await ChatController.handleWithRunEngine(
        req,
        chatRequest,
        env,
      );
      console.log(
        `[chat/timing] ${correlationId} totalMs=${Date.now() - requestStartedAt} status=${response.status}`,
      );
      return response;
    } catch (error: unknown) {
      if (isDomainError(error)) {
        const errorCorrelationId = error.correlationId ?? correlationId;
        console.warn(
          `[chat/validation] ${errorCorrelationId}: ${error.code} - ${error.message}`,
        );
        const { status, code, message, metadata } = mapDomainErrorToHttp(error);
        console.log(
          `[chat/timing] ${errorCorrelationId} totalMs=${Date.now() - requestStartedAt} status=${status} code=${code}`,
        );
        return errorResponse(req, env, message, status, code, metadata);
      }
      logErrorRateLimited(
        `chat/error:${errorMessageKey(error)}`,
        `[chat/error] ${correlationId}: ${sanitizeUnknownError(error)}`,
        undefined,
        30_000,
      );
      const errorMessage =
        error instanceof Error ? error.message : "Internal Server Error";
      console.log(
        `[chat/timing] ${correlationId} totalMs=${Date.now() - requestStartedAt} status=500`,
      );
      return errorResponse(req, env, errorMessage, 500);
    }
  }

  static async handleLegacyRoute(req: Request, env: Env): Promise<Response> {
    return errorResponse(
      req,
      env,
      "Legacy chat route '/api/chat' is no longer supported. Use '/chat'.",
      410,
      "LEGACY_CHAT_ROUTE_REMOVED",
    );
  }

  static async handleAgentInfo(req: Request, env: Env): Promise<Response> {
    console.log("[chat/agent-info] returning available agent types");

    const availableAgents = [
      {
        type: "coding" as AgentType,
        capabilities: [
          { name: "code_generation", description: "Generate and modify code" },
          {
            name: "file_operations",
            description: "Read, write, and manage files",
          },
          { name: "shell_execution", description: "Execute shell commands" },
        ],
      },
      {
        type: "review" as AgentType,
        capabilities: [
          {
            name: "code_review",
            description: "Review code for quality and issues",
          },
          {
            name: "security_audit",
            description: "Check for security vulnerabilities",
          },
        ],
      },
    ];

    return jsonResponse(req, env, { agents: availableAgents });
  }

  private static async handleWithRunEngine(
    req: Request,
    chatRequest: ChatRequest,
    env: Env,
  ): Promise<Response> {
    const { body, correlationId, sessionId, runId, userId, workspaceId } =
      chatRequest;
    const admissionService = new RunAdmissionService(env);
    let admissionGrant: Awaited<
      ReturnType<RunAdmissionService["enforce"]>
    > | undefined;

    const coreMessages = applySubmittedClientMessageId(
      chatRequest.imageInput.messages,
      body.clientMessageId,
      correlationId,
    );
    console.log(
      `[chat/request] ${correlationId} normalizedMessages=${summarizeCoreMessages(coreMessages)}`,
    );

    const prompt = extractPromptFromMessages(coreMessages, correlationId);
    const admissionInput = {
      userId,
      workspaceId,
      sessionId,
      clientFingerprint: await buildAdmissionScopeFingerprint(req),
      mode: body.mode,
      workflowIntent: body.workflowIntent,
    };

    try {
      await enforceImageCapability({
        env,
        userId,
        workspaceId,
        providerId: body.providerId,
        modelId: body.modelId,
        hasImages: chatRequest.imageInput.hasImages,
        correlationId,
      });
      admissionGrant = await admissionService.enforce(admissionInput, correlationId);

      const executionStartedAt = Date.now();
      const useCase = new HandleChatRequest(env);

      const useCaseStartedAt = Date.now();
      const useCaseResult = await useCase.execute(
        {
          sessionId,
          runId,
          userId,
          workspaceId,
          correlationId,
          agentType: mapAgentIdToType(body.agentId, correlationId),
          mode: body.mode,
          prompt,
          messages: coreMessages,
          providerId: body.providerId,
          modelId: body.modelId,
          harnessId: body.harnessId,
          orchestratorBackend: body.orchestratorBackend,
          executionBackend: body.executionBackend,
          harnessMode: body.harnessMode,
          authMode: body.authMode,
          productMode: body.productMode,
          workflowIntent: body.workflowIntent,
          workflowEntrypoint: body.workflowEntrypoint,
          repositoryOwner: body.repositoryOwner,
          repositoryName: body.repositoryName,
          repositoryBranch: body.repositoryBranch,
          repositoryBaseUrl: body.repositoryBaseUrl,
          tools: body.tools,
        },
        req.headers.get("Origin") || undefined,
      );
      const useCaseElapsedMs = Date.now() - useCaseStartedAt;

      const runEngineStartedAt = Date.now();
      const doResponse = await executeViaRunEngineDurableObject(
        env,
        runId,
        useCaseResult.executionPayload,
      );
      const runtimeTarget = resolveRuntimeTarget(
        env,
        useCaseResult.executionPayload.input.orchestratorBackend,
      );
      const runEngineElapsedMs = Date.now() - runEngineStartedAt;
      console.log(
        `[chat/timing] ${correlationId} useCaseMs=${useCaseElapsedMs} runEngineMs=${runEngineElapsedMs} handleMs=${Date.now() - executionStartedAt}`,
      );

      return withEngineHeaders(req, env, doResponse, runId, runtimeTarget);
    } catch (error) {
      console.error(
        `[chat/runtime] ${correlationId}: RunEngine execution failed:`,
        error,
      );
      throw error;
    } finally {
      if (admissionGrant) {
        await admissionService.release(admissionGrant, admissionInput, correlationId);
      }
    }
  }

}
