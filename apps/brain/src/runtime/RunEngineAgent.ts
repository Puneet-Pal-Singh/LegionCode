import { CloudflareAgent } from "@shadowbox/orchestrator-adapters-cloudflare-agents";
import type { Env } from "../types/ai";
import { errorResponse } from "../http/response";
import { createCloudflareEventStreamPort } from "./factories/PortalityAdapterFactory";
import { RunEngineRequestHandler } from "./RunEngineRequestHandler";
import { persistAssistantMessageFromRunResponse } from "./RunEngineResponsePersistence";
import { RunExecutionLock } from "./RunExecutionLock";

export class RunEngineAgent extends CloudflareAgent<Env> {
  private readonly executionLock = new RunExecutionLock();
  private readonly eventStreamPort = createCloudflareEventStreamPort();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const handler = new RunEngineRequestHandler(
      this.ctx,
      this.env,
      this.withExecutionLock.bind(this),
      this.eventStreamPort,
    );

    if (url.pathname === "/execute" && request.method === "POST") {
      return handler.handleExecuteRequest(request, async (result) => {
        await persistAssistantMessageFromRunResponse(
          this.ctx,
          this.env,
          result.sessionId,
          result.runId,
          result.correlationId,
          result.response,
        );
      });
    }

    if (url.pathname === "/summary" && request.method === "GET") {
      return handler.handleSummaryRequest(request);
    }

    if (url.pathname === "/events" && request.method === "GET") {
      return handler.handleEventsRequest(request);
    }

    if (url.pathname === "/events/stream" && request.method === "GET") {
      return handler.handleEventsStreamRequest(request);
    }

    if (url.pathname === "/activity" && request.method === "GET") {
      return handler.handleActivityRequest(request);
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      return handler.handleCancelRequest(request);
    }

    if (url.pathname === "/approval" && request.method === "POST") {
      return handler.handleApprovalRequest(request);
    }

    if (url.pathname === "/debug/runtime" && request.method === "GET") {
      return handler.handleRuntimeDebugRequest(request);
    }

    return errorResponse(request, this.env, "Not Found", 404);
  }

  private async withExecutionLock<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.executionLock.run(runId, operation);
  }
}
