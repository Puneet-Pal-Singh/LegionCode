import type { AgentType } from "@legioncode/execution-engine/runtime";
import type { Env } from "../types/ai";
import { errorResponse, jsonResponse } from "../http/response";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import { reportBrainError } from "../core/observability/BrainErrorReporter";
import { parseAuthenticatedChatRequest } from "./ChatRequestBoundary";
import type { BackgroundTaskOwner } from "../services/thread-titles";
import { submitHostedChat } from "../integration/app-server/HostedChatSubmission";

/**
 * ChatController
 * Single Responsibility: validate request and route chat execution through RunEngine.
 */
export class ChatController {
  static async handle(
    req: Request,
    env: Env,
    backgroundTaskOwner?: BackgroundTaskOwner,
    executionContext?: ExecutionContext,
  ): Promise<Response> {
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
          productMode: chatRequest.body.productMode ?? null,
          messageCount: chatRequest.body.messages?.length ?? 0,
        })}`,
      );

      console.log(`[chat/request] ${correlationId} routing to RunEngine`);
      const response = await submitHostedChat(
        req,
        chatRequest,
        env,
        backgroundTaskOwner,
        executionContext,
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
      "Legacy chat route '/api/chat' is no longer supported. Use App Server 'turn/submit'.",
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

}
