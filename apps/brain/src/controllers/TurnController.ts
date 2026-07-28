import { TurnScopeBootstrapRequestSchema } from "@repo/platform-protocol";
import { errorResponse, jsonResponse } from "../http/response";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import type { Env } from "../types/ai";
import {
  fetchRunTurnScope,
  resolveExecutionScope,
  startRunTurn,
} from "./chat-runtime-helpers";

const PUBLIC_TURN_START_SCHEMA = TurnScopeBootstrapRequestSchema.pick({
  runId: true,
  sessionId: true,
  clientMessageId: true,
});
type PublicTurnStartRequest = {
  runId: string;
  sessionId: string;
  clientMessageId?: string;
};

/** Public control-plane handoff for the server-owned turn scope. */
export class TurnController {
  static async start(req: Request, env: Env): Promise<Response> {
    const correlationId =
      req.headers.get("X-Correlation-Id") ?? crypto.randomUUID();

    try {
      const body = validateWithSchema<PublicTurnStartRequest>(
        await parseRequestBody(req, correlationId),
        PUBLIC_TURN_START_SCHEMA,
        correlationId,
      );
      const scope = await resolveExecutionScope(
        req,
        env,
        body.runId,
        correlationId,
      );
      const identity = await startRunTurn(
        env,
        body.runId,
        {
          sessionId: body.sessionId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          correlationId,
          clientMessageId: body.clientMessageId,
        },
        "execution-engine-v1",
      );
      return jsonResponse(req, env, identity, { status: 201 });
    } catch (error: unknown) {
      if (isDomainError(error)) {
        const { status, code, message, metadata } = mapDomainErrorToHttp(error);
        return errorResponse(req, env, message, status, code, metadata);
      }
      return errorResponse(
        req,
        env,
        "Failed to establish the server-owned turn scope.",
        500,
        "TURN_BOOTSTRAP_FAILED",
      );
    }
  }

  static async scope(req: Request, env: Env): Promise<Response> {
    const correlationId =
      req.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
    const url = new URL(req.url);
    const runId = url.searchParams.get("runId")?.trim();
    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!runId || !sessionId) {
      return errorResponse(
        req,
        env,
        "runId and sessionId are required",
        400,
        "TURN_SCOPE_QUERY_INVALID",
      );
    }

    try {
      // Resolve the authenticated run workspace before forwarding to its DO.
      // The DO then applies the exact session/run identity match.
      await resolveExecutionScope(req, env, runId, correlationId);
      const response = await fetchRunTurnScope(
        env,
        runId,
        sessionId,
        "execution-engine-v1",
      );
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error: unknown) {
      if (isDomainError(error)) {
        const { status, code, message, metadata } = mapDomainErrorToHttp(error);
        return errorResponse(req, env, message, status, code, metadata);
      }
      return errorResponse(
        req,
        env,
        "Failed to reconstruct the server-owned turn scope.",
        500,
        "TURN_SCOPE_READ_FAILED",
      );
    }
  }
}
