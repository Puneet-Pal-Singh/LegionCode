import {
  createRunAttemptId,
  createThreadId,
  turnIdFromRunId,
  TurnIdSchema,
  TurnScopeBootstrapSchema,
  type TurnScopeBootstrap,
} from "@repo/platform-protocol";
import { TurnAdmissionConflictError } from "@repo/persistence";
import {
  AppServerOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import type { AppServerRequest } from "@legioncode/app-server/protocol";
import { isDomainError, mapDomainErrorToHttp } from "../../domain/errors";
import type { Env } from "../../types/ai";
import {
  resolveExecutionScope,
  startRunTurn,
} from "../../controllers/chat-runtime-helpers";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";

type ReserveRequest = Extract<
  AppServerRequest,
  { method: "turn/reserve" }
>["params"];
type ReadRequest = Extract<
  AppServerRequest,
  { method: "turn/scope" }
>["params"];

/** Turn scope is composed only after the hosted App Server verifies its cookie principal. */
export function composeHostedTurnScope(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedTurnScopeService"]> {
  return {
    reserve: (params) => reserve(request, env, userId, params),
    read: (params) => read(request, env, userId, params),
  };
}

async function reserve(
  request: Request,
  env: Env,
  userId: string,
  params: ReserveRequest,
): Promise<TurnScopeBootstrap> {
  const correlationId =
    request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  try {
    const scope = await resolveExecutionScope(
      request,
      env,
      params.runId,
      correlationId,
    );
    if (scope.userId !== userId)
      throw new Error(
        "Authenticated principal changed during turn reservation",
      );
    const session = await withTranscriptRepository(
      env,
      async (repository) =>
        (await repository.listSessions(scope.userId)).sessions.find(
          (candidate) => candidate.id === params.sessionId,
        ) ?? null,
    );
    if (!session)
      throw new AppServerOperationError(
        404,
        "not_found",
        "Conversation not found",
        "SESSION_NOT_FOUND",
      );
    if (
      session.workspaceId != null &&
      session.workspaceId !== scope.workspaceId
    ) {
      throw new AppServerOperationError(
        409,
        "conflict",
        "Conversation workspace does not match",
        "TURN_SCOPE_MISMATCH",
      );
    }
    const reserved = await withTurnAdmissionRepository(env, (repository) =>
      repository.reserve({
        sessionId: params.sessionId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        clientMessageId: params.clientMessageId,
        threadId: session.threadId ?? createThreadId(),
        turnId: turnIdFromRunId(params.runId, params.clientMessageId),
        runAttemptId: createRunAttemptId(),
        runId: params.runId,
        revisionOfTurnId: params.revisionOfTurnId
          ? TurnIdSchema.parse(params.revisionOfTurnId)
          : undefined,
      }),
    );
    const admittedIdentity = admissionIdentity(scope.workspaceId, reserved);
    return await startRunTurn(
      env,
      params.runId,
      {
        sessionId: params.sessionId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        correlationId,
        clientMessageId: params.clientMessageId,
        revisionOfTurnId: params.revisionOfTurnId,
        admittedIdentity,
      },
      "execution-engine-v1",
    );
  } catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    throw operationError(
      error,
      500,
      "TURN_BOOTSTRAP_FAILED",
      "Failed to establish the server-owned turn scope.",
    );
  }
}

async function read(
  request: Request,
  env: Env,
  userId: string,
  query: ReadRequest,
): Promise<TurnScopeBootstrap> {
  const correlationId =
    request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  try {
    const scope = await resolveExecutionScope(
      request,
      env,
      query.runId,
      correlationId,
    );
    if (scope.userId !== userId)
      throw new Error("Authenticated principal changed during turn scope read");
    const run = await withRunRepository(env, (repository) =>
      repository.getRun(query.runId, scope.userId),
    );
    if (!run || run.sessionId !== query.sessionId) {
      throw new AppServerOperationError(
        404,
        "not_found",
        "Run not found for owned conversation",
        "RUN_SCOPE_NOT_FOUND",
      );
    }
    const admission = await withTurnAdmissionRepository(env, (repository) =>
      repository.getBySessionAndRunId(query.sessionId, query.runId),
    );
    if (
      !admission ||
      admission.userId !== scope.userId ||
      admission.workspaceId !== scope.workspaceId ||
      (run.workspaceId !== null && run.workspaceId !== scope.workspaceId)
    ) {
      throw new AppServerOperationError(
        404,
        "not_found",
        "No durable turn admission exists for this conversation and run",
        "TURN_SCOPE_NOT_FOUND",
      );
    }
    if (admission.state !== "admitted") {
      throw new AppServerOperationError(
        409,
        "conflict",
        "Turn admission is reserved but prompt persistence has not completed",
        "TURN_ADMISSION_RECOVERY_REQUIRED",
      );
    }
    return admissionIdentity(scope.workspaceId, admission);
  } catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    throw operationError(
      error,
      500,
      "TURN_SCOPE_READ_FAILED",
      "Failed to reconstruct the server-owned turn scope.",
    );
  }
}

function admissionIdentity(
  workspaceId: string,
  admission: {
    threadId: string;
    turnId: string;
    runAttemptId: string;
    revisionOfTurnId: string | null;
    continuationOfTurnId: string | null;
    originalPromptId: string | null;
  },
): TurnScopeBootstrap {
  return TurnScopeBootstrapSchema.parse({
    workspaceId,
    threadId: admission.threadId,
    turnId: admission.turnId,
    runAttemptId: admission.runAttemptId,
    ...(admission.revisionOfTurnId
      ? { revisionOfTurnId: admission.revisionOfTurnId }
      : {}),
    ...(admission.continuationOfTurnId || admission.originalPromptId
      ? {
          continuationOfTurnId: admission.continuationOfTurnId,
          originalPromptId: admission.originalPromptId,
        }
      : {}),
  });
}

function operationError(
  error: unknown,
  fallbackStatus: number,
  fallbackCode: string,
  fallbackMessage: string,
): AppServerOperationError {
  if (isDomainError(error)) {
    const { status, code, message } = mapDomainErrorToHttp(error);
    return new AppServerOperationError(
      status,
      errorCategory(status),
      message,
      code,
    );
  }
  if (error instanceof TurnAdmissionConflictError) {
    return new AppServerOperationError(
      409,
      "conflict",
      error.message,
      error.code.toUpperCase(),
    );
  }
  return new AppServerOperationError(
    fallbackStatus,
    errorCategory(fallbackStatus),
    fallbackMessage,
    fallbackCode,
  );
}

function errorCategory(
  status: number,
):
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "server_unavailable" {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server_unavailable";
  return "invalid_request";
}
