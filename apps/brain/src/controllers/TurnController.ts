import {
  createRunAttemptId,
  createThreadId,
  turnIdFromRunId,
  TurnIdSchema,
  TurnScopeBootstrapRequestSchema,
  TurnScopeBootstrapSchema,
} from "@repo/platform-protocol";
import { errorResponse, jsonResponse } from "../http/response";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import type { Env } from "../types/ai";
import { TurnAdmissionConflictError } from "@repo/persistence";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import { withTurnAdmissionRepository } from "../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";
import {
  resolveExecutionScope,
  startRunTurn,
} from "./chat-runtime-helpers";

const PUBLIC_TURN_START_SCHEMA = TurnScopeBootstrapRequestSchema.pick({
  runId: true,
  sessionId: true,
  clientMessageId: true,
  revisionOfTurnId: true,
}).extend({ clientMessageId: TurnScopeBootstrapRequestSchema.shape.clientMessageId.unwrap() });
type PublicTurnStartRequest = {
  runId: string;
  sessionId: string;
  clientMessageId: string;
  revisionOfTurnId?: ReturnType<typeof TurnIdSchema.parse>;
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
      const session = await withTranscriptRepository(env, async (repository) =>
        (await repository.listSessions(scope.userId)).sessions.find(
          (candidate) => candidate.id === body.sessionId,
        ) ?? null,
      );
      if (!session) {
        return errorResponse(req, env, "Conversation not found", 404, "SESSION_NOT_FOUND");
      }
      if (session.workspaceId != null && session.workspaceId !== scope.workspaceId) {
        return errorResponse(req, env, "Conversation workspace does not match", 409, "TURN_SCOPE_MISMATCH");
      }
      const reserved = await withTurnAdmissionRepository(env, (repository) =>
        repository.reserve({
          sessionId: body.sessionId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          clientMessageId: body.clientMessageId,
          threadId: session.threadId ?? createThreadId(),
          turnId: turnIdFromRunId(body.runId, body.clientMessageId),
          runAttemptId: createRunAttemptId(),
          runId: body.runId,
          revisionOfTurnId: body.revisionOfTurnId
            ? TurnIdSchema.parse(body.revisionOfTurnId)
            : undefined,
        }),
      );
      const admittedIdentity = TurnScopeBootstrapSchema.parse({
        workspaceId: scope.workspaceId,
        threadId: reserved.threadId,
        turnId: reserved.turnId,
        runAttemptId: reserved.runAttemptId,
        ...(reserved.revisionOfTurnId ? { revisionOfTurnId: reserved.revisionOfTurnId } : {}),
      });
      const identity = await startRunTurn(
        env,
        body.runId,
        {
          sessionId: body.sessionId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          correlationId,
          clientMessageId: body.clientMessageId,
          revisionOfTurnId: body.revisionOfTurnId,
          admittedIdentity,
        },
        "execution-engine-v1",
      );
      return jsonResponse(req, env, identity, { status: 201 });
    } catch (error: unknown) {
      if (isDomainError(error)) {
        const { status, code, message, metadata } = mapDomainErrorToHttp(error);
        return errorResponse(req, env, message, status, code, metadata);
      }
      if (error instanceof TurnAdmissionConflictError) {
        return errorResponse(req, env, error.message, 409, error.code.toUpperCase());
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
      const scope = await resolveExecutionScope(req, env, runId, correlationId);
      const run = await withRunRepository(env, (repository) =>
        repository.getRun(runId, scope.userId),
      );
      if (!run || run.sessionId !== sessionId) {
        return errorResponse(req, env, "Run not found for owned conversation", 404, "RUN_SCOPE_NOT_FOUND");
      }
      const admission = await withTurnAdmissionRepository(env, (repository) =>
        repository.getBySessionAndRunId(sessionId, runId),
      );
      if (
        !admission ||
        admission.userId !== scope.userId ||
        admission.workspaceId !== scope.workspaceId ||
        (run.workspaceId !== null && run.workspaceId !== scope.workspaceId)
      ) {
        return errorResponse(req, env, "No durable turn admission exists for this conversation and run", 404, "TURN_SCOPE_NOT_FOUND");
      }
      if (admission.state !== "admitted") {
        return errorResponse(req, env, "Turn admission is reserved but prompt persistence has not completed", 409, "TURN_ADMISSION_RECOVERY_REQUIRED");
      }
      if (admission.executionState === "recovery_required") {
        return errorResponse(req, env, "This turn has an execution claim without a confirmed terminal result and requires recovery review.", 409, "TURN_EXECUTION_RECOVERY_REQUIRED");
      }
      return jsonResponse(req, env, TurnScopeBootstrapSchema.parse({
        workspaceId: scope.workspaceId,
        threadId: admission.threadId,
        turnId: admission.turnId,
        runAttemptId: admission.runAttemptId,
        ...(admission.revisionOfTurnId ? { revisionOfTurnId: admission.revisionOfTurnId } : {}),
      }));
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
