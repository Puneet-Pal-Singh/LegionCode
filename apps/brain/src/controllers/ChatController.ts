import type { AgentType } from "@shadowbox/execution-engine/runtime";
import type { Env } from "../types/ai";
import { HandleChatRequest } from "../application/chat";
import {
  errorResponse,
  jsonResponse,
  withEngineHeaders,
} from "../http/response";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import { mapAgentIdToType } from "./chat-request-helpers";
import {
  executeViaRunEngineDurableObject,
  extractPromptFromMessages,
  resolveRuntimeTarget,
} from "./chat-runtime-helpers";
import { RunAdmissionService } from "../runtime/RunAdmissionService";
import { enforceImageCapability } from "../services/chat/ImageCapabilityGate";
import {
  applySubmittedClientMessageId,
  summarizeCoreMessages,
} from "../services/chat/SubmittedClientMessagePolicy";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";
import { reportBrainError } from "../core/observability/BrainErrorReporter";
import {
  parseAuthenticatedChatRequest,
  type AuthenticatedChatRequest,
} from "./ChatRequestBoundary";

/**
 * ChatController
 * Single Responsibility: validate request and route chat execution through RunEngine.
 */
export class ChatController {
  static async handle(req: Request, env: Env): Promise<Response> {
    const correlationId =
      req.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
    const requestStartedAt = Date.now();
    console.log(`[chat/request] ${correlationId} received`);

    try {
      const chatRequest = await parseAuthenticatedChatRequest(
        req,
        env,
        correlationId,
      );

      console.log(
        `[chat/request] ${correlationId} session: ${chatRequest.sessionId}, run: ${chatRequest.runId}`,
      );
      console.log(
        `[chat/request] ${correlationId} messages: ${chatRequest.body.messages?.length || 0}`,
      );
      console.log(
        `[chat/request] ${correlationId} envelope=${JSON.stringify({
          sessionId: chatRequest.sessionId,
          runId: chatRequest.runId,
          clientMessageId: chatRequest.body.clientMessageId ?? null,
          providerId: chatRequest.body.providerId ?? null,
          modelId: chatRequest.body.modelId ?? null,
          mode: chatRequest.body.mode ?? null,
          messageCount: chatRequest.body.messages?.length ?? 0,
        })}`,
      );

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
      reportBrainError(env, {
        request: req,
        operation: "chat.request.execute",
        error,
        context: { correlationId, elapsedMs: Date.now() - requestStartedAt },
      });
      console.log(
        `[chat/timing] ${correlationId} totalMs=${Date.now() - requestStartedAt} status=500`,
      );
      return errorResponse(
        req,
        env,
        "Internal Server Error",
        500,
        "CHAT_REQUEST_FAILED",
      );
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
    chatRequest: AuthenticatedChatRequest,
    env: Env,
  ): Promise<Response> {
    const {
      body,
      correlationId,
      sessionId,
      runId,
      userId,
      workspaceId,
      identity,
    } = chatRequest;
    const admissionService = new RunAdmissionService(env);
    let admissionGrant:
      | Awaited<ReturnType<RunAdmissionService["enforce"]>>
      | undefined;

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
      threadId: identity.threadId,
      runAttemptId: identity.runAttemptId,
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
      admissionGrant = await admissionService.enforce(
        admissionInput,
        correlationId,
      );

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
          identity,
        },
        req.headers.get("Origin") || undefined,
      );
      const useCaseElapsedMs = Date.now() - useCaseStartedAt;

      const runEngineStartedAt = Date.now();
      console.log(
        formatDiagnosticLogLine("chat/runtime", "dispatching-run-engine", {
          correlationId,
          runId,
          sessionId,
          providerId: body.providerId ?? null,
          modelId: body.modelId ?? null,
          mode: body.mode,
          clientMessageId: body.clientMessageId ?? null,
        }),
      );
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
        formatDiagnosticLogLine("chat/runtime", "run-engine-returned", {
          correlationId,
          runId,
          sessionId,
          responseStatus: doResponse.status,
          runtimeTarget,
          elapsedMs: runEngineElapsedMs,
        }),
      );
      console.log(
        formatDiagnosticLogLine("chat/runtime", "timing", {
          correlationId,
          runId,
          sessionId,
          useCaseMs: useCaseElapsedMs,
          runEngineMs: runEngineElapsedMs,
          handleMs: Date.now() - executionStartedAt,
        }),
      );

      return withEngineHeaders(req, env, doResponse, runId, runtimeTarget);
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("chat/runtime", "run-engine-failed", {
          correlationId,
          runId,
          sessionId,
          error,
        }),
        error,
      );
      throw error;
    } finally {
      if (admissionGrant) {
        await admissionService.release(admissionGrant, correlationId);
      }
    }
  }
}
