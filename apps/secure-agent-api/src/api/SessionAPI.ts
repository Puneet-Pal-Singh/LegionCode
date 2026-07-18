/**
 * Session API Handlers
 * HTTP endpoints for the canonical Brain-to-secure-runtime boundary.
 */

import {
  SessionCreateRequestSchema,
  SessionResumeRequestSchema,
  ExecuteTaskRequestSchema,
  ExecuteTaskResponseSchema,
  validateRequestBody,
  jsonResponse,
  errorResponse,
  type ExecuteTaskRequest,
  type ExecuteTaskResponse,
} from "../schemas/http-api";
import type {
  SandboxExecutionPort,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../ports/SandboxExecutionPort";
import type { RuntimeEventPublisher } from "../services/runtime-events/InternalRuntimeEventClient";
import type { JsonValue } from "@repo/shared-types";
import {
  createSandboxLease,
  type SandboxExecutionLease,
} from "../ports/SandboxExecutionLease";
import {
  sanitizeLogText,
  sanitizeUnknownError,
} from "../core/security/LogSanitizer";

type RuntimeStub = Record<string, unknown>;

const SESSION_TTL_MS = 3600000;
const EXECUTION_NOT_IMPLEMENTED_CODE = "EXECUTION_NOT_IMPLEMENTED";

interface SessionRecord {
  runId: string;
  taskId: string;
  repoPath: string;
  expiresAt: number;
  token: string;
  createdAt: number;
  workspaceScope: WorkspaceScope;
  lease: SandboxExecutionLease;
}

interface PublicSessionRecord {
  runId: string;
  taskId: string;
  repoPath: string;
  expiresAt: number;
  createdAt: number;
  workspaceScope: WorkspaceScope;
  lease: SandboxExecutionLease;
}

interface WorkspaceScope {
  runId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  workspaceId: string;
  root: string;
}

interface SessionLogEntry {
  taskId?: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: "stdout" | "stderr";
}

interface RuntimeSessionStore {
  storeExecutionSession: (
    sessionId: string,
    session: SessionRecord,
  ) => Promise<void>;
  getExecutionSession: (sessionId: string) => Promise<SessionRecord | null>;
  appendExecutionLog: (
    sessionId: string,
    entry: SessionLogEntry,
  ) => Promise<void>;
  getExecutionLogs: (
    sessionId: string,
    since?: number,
    taskId?: string,
  ) => Promise<SessionLogEntry[]>;
  deleteExecutionSession: (sessionId: string) => Promise<void>;
}

type LeaseRuntime = RuntimeStub & {
  releaseLease?: (leaseId: string) => Promise<void>;
};

function generateSessionId(): string {
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sess_${Date.now()}_${randomHex}`;
}

function generateToken(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `tok_${randomHex}`;
}

function parseBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer (.+)$/);
  return match?.[1] ?? null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

function getRuntimeSessionStore(
  runtime: RuntimeStub,
): RuntimeSessionStore | null {
  const candidate = runtime as Record<string, unknown>;
  const storeExecutionSession = candidate.storeExecutionSession;
  const getExecutionSession = candidate.getExecutionSession;
  const appendExecutionLog = candidate.appendExecutionLog;
  const getExecutionLogs = candidate.getExecutionLogs;
  const deleteExecutionSession = candidate.deleteExecutionSession;

  if (
    typeof storeExecutionSession !== "function" ||
    typeof getExecutionSession !== "function" ||
    typeof appendExecutionLog !== "function" ||
    typeof getExecutionLogs !== "function" ||
    typeof deleteExecutionSession !== "function"
  ) {
    return null;
  }

  return {
    storeExecutionSession:
      storeExecutionSession as RuntimeSessionStore["storeExecutionSession"],
    getExecutionSession:
      getExecutionSession as RuntimeSessionStore["getExecutionSession"],
    appendExecutionLog:
      appendExecutionLog as RuntimeSessionStore["appendExecutionLog"],
    getExecutionLogs:
      getExecutionLogs as RuntimeSessionStore["getExecutionLogs"],
    deleteExecutionSession:
      deleteExecutionSession as RuntimeSessionStore["deleteExecutionSession"],
  };
}

async function storeSession(
  runtime: RuntimeStub,
  sessionId: string,
  runId: string,
  taskId: string,
  repoPath: string,
  token: string,
  workspaceScope: WorkspaceScope,
): Promise<{ expiresAt: number; lease: SandboxExecutionLease }> {
  const sessionStore = getRuntimeSessionStore(runtime);
  if (!sessionStore) {
    throw new Error("Session storage is unavailable");
  }

  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const lease = await createSandboxLease({
    workspaceScope,
    owner: sessionId,
    correlationId: `secure-api:${sessionId}`,
    now,
  });
  await sessionStore.storeExecutionSession(sessionId, {
    runId,
    taskId,
    repoPath,
    expiresAt,
    token,
    createdAt: now,
    workspaceScope,
    lease,
  });
  return { expiresAt, lease };
}

async function getActiveSession(
  runtime: RuntimeStub,
  sessionId: string,
): Promise<SessionRecord | null> {
  const sessionStore = getRuntimeSessionStore(runtime);
  if (!sessionStore) {
    return null;
  }

  const session = await sessionStore.getExecutionSession(sessionId);
  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    const releaseLease = (runtime as LeaseRuntime).releaseLease;
    if (typeof releaseLease === "function") {
      await releaseLease(session.lease.leaseId);
    }
    await sessionStore.deleteExecutionSession(sessionId);
    return null;
  }

  return session;
}

async function recordLog(
  runtime: RuntimeStub,
  sessionId: string,
  level: SessionLogEntry["level"],
  message: string,
  source?: SessionLogEntry["source"],
  taskId?: string,
): Promise<void> {
  const sessionStore = getRuntimeSessionStore(runtime);
  if (!sessionStore) {
    return;
  }

  await sessionStore.appendExecutionLog(sessionId, {
    taskId,
    timestamp: Date.now(),
    level,
    message: sanitizeLogText(message),
    source,
  });
}

async function authorizeSessionRequest(
  request: Request,
  runtime: RuntimeStub,
  sessionId: string,
): Promise<
  { ok: true; session: SessionRecord } | { ok: false; response: Response }
> {
  const session = await getActiveSession(runtime, sessionId);
  if (!session) {
    return {
      ok: false,
      response: errorResponse(
        "Session not found or expired",
        "SESSION_NOT_FOUND",
        404,
      ),
    };
  }

  const providedToken = parseBearerToken(request);
  if (!providedToken || !constantTimeEqual(providedToken, session.token)) {
    return {
      ok: false,
      response: errorResponse("Unauthorized", "UNAUTHORIZED", 401),
    };
  }

  return { ok: true, session };
}

async function fetchManifest(runtime: RuntimeStub): Promise<unknown> {
  try {
    const getManifest = (runtime as Record<string, unknown>).getManifest;
    if (typeof getManifest !== "function") {
      return undefined;
    }
    const result = getManifest();
    return result instanceof Promise ? await result : result;
  } catch (error) {
    console.warn("[api/session] Failed to get manifest:", error);
    return undefined;
  }
}

function getRuntimeExecutionPort(
  runtime: RuntimeStub,
): Pick<SandboxExecutionPort, "executeTask"> | null {
  const candidate = runtime as Record<string, unknown>;
  const executionPort = candidate.executionPort;
  if (
    executionPort &&
    typeof executionPort === "object" &&
    typeof (executionPort as SandboxExecutionPort).executeTask === "function"
  ) {
    return executionPort as Pick<SandboxExecutionPort, "executeTask">;
  }

  const executeTask = candidate.executeTask;
  if (typeof executeTask !== "function") {
    return null;
  }

  return {
    executeTask: (sessionId: string, input: TaskExecutionInput) =>
      (
        executeTask as (
          sessionIdArg: string,
          inputArg: TaskExecutionInput,
        ) => Promise<TaskExecutionResult>
      )(sessionId, input),
  };
}

function extractSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/v1\/session\/(.+)$/);
  return match?.[1] ?? null;
}

function extractResumedSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/v1\/session\/([^/]+)\/resume$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function parseExecutionResponse(result: unknown): ExecuteTaskResponse | null {
  const parsed = ExecuteTaskResponseSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function toTaskExecutionInput(
  request: ExecuteTaskRequest,
): Omit<TaskExecutionInput, "lease"> {
  return {
    taskId: request.taskId,
    action: request.action,
    params: request.params,
    timeout: request.timeout,
    retryable: request.retryable,
  };
}

function getExecutionHttpStatus(result: ExecuteTaskResponse): number {
  if (result.status === "success") return 200;
  if (result.status === "timeout") return 504;
  if (result.status === "cancelled") return 499;
  if (result.status === "sandbox_unavailable") {
    return 503;
  }
  return 422;
}

function hasMatchingWorkspaceScope(
  session: SessionRecord,
  params: Record<string, unknown>,
): boolean {
  const requestedRunId = params.runId;
  if (requestedRunId !== undefined && requestedRunId !== session.runId) {
    return false;
  }
  const candidate = params.workspaceScope;
  if (!isWorkspaceScope(candidate)) {
    return false;
  }
  return workspaceScopesEqual(session.workspaceScope, candidate);
}

function workspaceScopesEqual(
  left: WorkspaceScope,
  right: WorkspaceScope,
): boolean {
  return (
    left.runId === right.runId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.runAttemptId === right.runAttemptId &&
    left.workspaceId === right.workspaceId &&
    left.root === right.root
  );
}

async function replaceDeadLease(
  runtime: RuntimeStub,
  sessionId: string,
  session: SessionRecord,
): Promise<void> {
  const sessionStore = getRuntimeSessionStore(runtime);
  if (!sessionStore) return;
  const nextGeneration = session.lease.generation + 1;
  const replacement = await createSandboxLease({
    workspaceScope: session.workspaceScope,
    owner: sessionId,
    correlationId: `${session.lease.correlationId}:replacement-${nextGeneration}`,
    generation: nextGeneration,
  });
  await sessionStore.storeExecutionSession(sessionId, {
    ...session,
    lease: replacement,
  });
}

function isWorkspaceScope(value: unknown): value is WorkspaceScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.runAttemptId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.root === "string"
  );
}

function getExecutionLogLevel(
  result: ExecuteTaskResponse,
): SessionLogEntry["level"] {
  return result.status === "success" ? "info" : "error";
}

function getExecutionLogMessage(result: ExecuteTaskResponse): string {
  const taskId = result.taskId.trim();
  const taskLabel = taskId.length > 0 ? `Task ${taskId}` : "Task";

  if (result.status === "success") {
    return `${taskLabel} executed successfully`;
  }

  if (result.error?.message) {
    return `${taskLabel} failed: ${result.error.message}`;
  }

  if (result.status === "timeout") {
    return `${taskLabel} execution timed out`;
  }

  if (result.status === "cancelled") {
    return `${taskLabel} execution was cancelled`;
  }

  return `${taskLabel} execution failed`;
}

function getExecutionLogSource(
  result: ExecuteTaskResponse,
): SessionLogEntry["source"] {
  return undefined;
}

export async function handleCreateSession(
  request: Request,
  runtime: RuntimeStub,
): Promise<Response> {
  console.log("[api/session] Handling session creation request");

  try {
    if (!getRuntimeSessionStore(runtime)) {
      return errorResponse(
        "Session storage unavailable",
        "SESSION_STORAGE_UNAVAILABLE",
        503,
      );
    }

    const validation = await validateRequestBody(
      request,
      SessionCreateRequestSchema,
    );
    if (!validation.valid) {
      console.warn(
        `[api/session] Validation failed: ${sanitizeLogText(validation.error)}`,
      );
      return errorResponse(validation.error, "INVALID_REQUEST", 400);
    }

    const { runId, taskId, repoPath, workspaceScope } = validation.data;
    const sessionId = generateSessionId();
    const token = generateToken();
    const storedSession = await storeSession(
      runtime,
      sessionId,
      runId,
      taskId,
      repoPath,
      token,
      workspaceScope,
    );
    const manifest = await fetchManifest(runtime);

    const response: Record<string, unknown> = {
      sessionId,
      token,
      expiresAt: storedSession.expiresAt,
      lease: storedSession.lease,
    };
    if (manifest) {
      response.manifest = manifest;
    }

    console.log(
      `[api/session] Session created: ${sessionId.substring(0, 8)}...`,
    );
    return jsonResponse(response, 201);
  } catch (error) {
    const msg = sanitizeUnknownError(error);
    console.error(`[api/session] Unexpected error: ${sanitizeLogText(msg)}`);
    return errorResponse(msg, "INTERNAL_ERROR", 500);
  }
}

/**
 * Rotates the short-lived bearer for one exact persisted checkout session.
 *
 * Routing must authenticate this handler as an internal Brain service-binding
 * request before invocation. The caller must also prove the complete persisted
 * workspace and lease identity; no session, lease, or checkout is guessed or
 * replaced here.
 */
export async function handleResumeSession(
  request: Request,
  runtime: RuntimeStub,
): Promise<Response> {
  try {
    const sessionId = extractResumedSessionIdFromPath(
      new URL(request.url).pathname,
    );
    if (!sessionId) {
      return errorResponse("Invalid session ID", "INVALID_REQUEST", 400);
    }
    const validation = await validateRequestBody(
      request,
      SessionResumeRequestSchema,
    );
    if (!validation.valid) {
      return errorResponse(validation.error, "INVALID_REQUEST", 400);
    }
    const session = await getActiveSession(runtime, sessionId);
    if (!session) {
      const sessionStore = getRuntimeSessionStore(runtime);
      if (!sessionStore) {
        return errorResponse(
          "Session storage unavailable",
          "SESSION_STORAGE_UNAVAILABLE",
          503,
        );
      }
      const token = generateToken();
      const now = Date.now();
      const lease = await createSandboxLease({
        workspaceScope: validation.data.workspaceScope,
        owner: sessionId,
        correlationId: `secure-api:${sessionId}:recovery-${validation.data.lease.generation + 1}`,
        generation: validation.data.lease.generation + 1,
        now,
      });
      const recovered: SessionRecord = {
        runId: validation.data.workspaceScope.runId,
        taskId: `recovered-${validation.data.workspaceScope.runAttemptId}`,
        repoPath: ".",
        expiresAt: now + SESSION_TTL_MS,
        token,
        createdAt: now,
        workspaceScope: validation.data.workspaceScope,
        lease,
      };
      await sessionStore.storeExecutionSession(sessionId, recovered);
      return jsonResponse(
        {
          sessionId,
          token,
          expiresAt: recovered.expiresAt,
          lease,
          replaced: true,
        },
        200,
      );
    }
    if (
      !workspaceScopesEqual(
        session.workspaceScope,
        validation.data.workspaceScope,
      )
    ) {
      return errorResponse(
        "Persisted checkout identity does not match the secure session",
        "SESSION_SCOPE_MISMATCH",
        409,
      );
    }
    const exactLease =
      session.lease.leaseId === validation.data.lease.leaseId &&
      session.lease.sandboxId === validation.data.lease.sandboxId &&
      session.lease.generation === validation.data.lease.generation;
    const pendingReplacement =
      session.lease.generation === validation.data.lease.generation + 1;
    if (!exactLease && !pendingReplacement) {
      return errorResponse(
        "Persisted checkout lease generation does not match the secure session",
        "SESSION_SCOPE_MISMATCH",
        409,
      );
    }
    const sessionStore = getRuntimeSessionStore(runtime);
    if (!sessionStore) {
      return errorResponse(
        "Session storage unavailable",
        "SESSION_STORAGE_UNAVAILABLE",
        503,
      );
    }
    const token = generateToken();
    const resumed: SessionRecord = {
      ...session,
      token,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    await sessionStore.storeExecutionSession(sessionId, resumed);
    return jsonResponse(
      {
        sessionId,
        token,
        expiresAt: resumed.expiresAt,
        lease: resumed.lease,
        replaced: pendingReplacement,
      },
      200,
    );
  } catch (error) {
    const message = sanitizeUnknownError(error);
    console.error(
      `[api/resume-session] status=failed error=${sanitizeLogText(message)}`,
    );
    return errorResponse(message, "INTERNAL_ERROR", 500);
  }
}

export async function handleExecuteTask(
  request: Request,
  runtime: RuntimeStub,
  runtimeEventPublisher?: RuntimeEventPublisher,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  console.log(`[api/execute] requestId=${requestId} status=received`);

  try {
    const validation = await validateRequestBody(
      request,
      ExecuteTaskRequestSchema,
    );
    if (!validation.valid) {
      console.warn(
        `[api/execute] requestId=${requestId} status=validation-failed error=${sanitizeLogText(validation.error)} elapsedMs=${Date.now() - startedAt}`,
      );
      return errorResponse(validation.error, "INVALID_REQUEST", 400);
    }

    const { sessionId } = validation.data;
    console.log(
      `[api/execute] requestId=${requestId} sessionId=${sessionId} taskId=${validation.data.taskId} action=${validation.data.action} status=validated`,
    );
    const auth = await authorizeSessionRequest(request, runtime, sessionId);
    if (!auth.ok) {
      console.warn(
        `[api/execute] requestId=${requestId} sessionId=${sessionId} taskId=${validation.data.taskId} action=${validation.data.action} status=unauthorized elapsedMs=${Date.now() - startedAt}`,
      );
      return auth.response;
    }
    if (!hasMatchingWorkspaceScope(auth.session, validation.data.params)) {
      return errorResponse(
        "Execution workspace scope does not match the session scope",
        "WORKSPACE_SCOPE_MISMATCH",
        409,
      );
    }

    const executionPort = getRuntimeExecutionPort(runtime);
    if (!executionPort) {
      await recordLog(
        runtime,
        sessionId,
        "warn",
        "Execution endpoint called but runtime task execution is not implemented",
        "stderr",
        validation.data.taskId,
      );
      return errorResponse(
        "Runtime execution is not implemented on this deployment",
        EXECUTION_NOT_IMPLEMENTED_CODE,
        501,
      );
    }

    await publishTaskEvent(runtimeEventPublisher, {
      eventType: "runtime.task.started",
      session: auth.session,
      sessionId,
      request: validation.data,
    });

    const runtimeResult = await executionPort.executeTask(
      sessionId,
      {
        ...toTaskExecutionInput(validation.data),
        lease: auth.session.lease,
      },
      {
        onLog: async (entry) => {
          await recordLog(
            runtime,
            sessionId,
            entry.source === "stderr" ? "error" : "info",
            entry.message,
            entry.source,
            validation.data.taskId,
          );
        },
      },
    );
    const executionResult = parseExecutionResponse(runtimeResult);
    if (!executionResult) {
      console.error(
        `[api/execute] requestId=${requestId} sessionId=${sessionId} taskId=${validation.data.taskId} action=${validation.data.action} status=invalid-runtime-response elapsedMs=${Date.now() - startedAt}`,
      );
      return errorResponse(
        "Runtime returned an invalid execution response",
        "INVALID_RUNTIME_RESPONSE",
        502,
      );
    }

    await publishTaskEvent(runtimeEventPublisher, {
      eventType: "runtime.task.finished",
      session: auth.session,
      sessionId,
      request: validation.data,
      result: executionResult,
    });

    if (executionResult.status === "sandbox_unavailable") {
      await replaceDeadLease(runtime, sessionId, auth.session);
    }

    await recordLog(
      runtime,
      sessionId,
      getExecutionLogLevel(executionResult),
      getExecutionLogMessage(executionResult),
      getExecutionLogSource(executionResult),
      executionResult.taskId,
    );

    console.log(
      `[api/execute] requestId=${requestId} sessionId=${sessionId} taskId=${executionResult.taskId} action=${validation.data.action} status=${executionResult.status} outputLength=${executionResult.output?.length ?? 0} durationMs=${executionResult.metrics?.duration ?? "none"} elapsedMs=${Date.now() - startedAt}`,
    );
    return jsonResponse(executionResult, getExecutionHttpStatus(executionResult));
  } catch (error) {
    const msg = sanitizeUnknownError(error);
    console.error(
      `[api/execute] requestId=${requestId} status=error elapsedMs=${Date.now() - startedAt} error=${JSON.stringify(msg)}`,
    );
    return errorResponse(msg, "INTERNAL_ERROR", 500);
  }
}

interface RuntimeTaskEventInput {
  eventType: "runtime.task.started" | "runtime.task.finished";
  session: SessionRecord;
  sessionId: string;
  request: ExecuteTaskRequest;
  result?: ExecuteTaskResponse;
}

async function publishTaskEvent(
  publisher: RuntimeEventPublisher | undefined,
  input: RuntimeTaskEventInput,
): Promise<void> {
  if (!publisher) {
    return;
  }

  await publisher.publish({
    source: "secure-agent-api",
    eventType: input.eventType,
    idempotencyKey: buildTaskEventIdempotencyKey(input),
    payloadSchemaVersion: 1,
    payload: buildTaskEventPayload(input),
  });
}

function buildTaskEventIdempotencyKey(input: RuntimeTaskEventInput): string {
  return [
    input.session.runId,
    input.sessionId,
    input.request.taskId,
    input.eventType,
  ].join(":");
}

function buildTaskEventPayload(input: RuntimeTaskEventInput): JsonValue {
  const payload: Record<string, JsonValue> = {
    runId: input.session.runId,
    sessionId: input.sessionId,
    taskId: input.request.taskId,
    action: input.request.action,
    status: input.result?.status ?? "started",
    retryable: input.request.retryable ?? false,
  };

  if (input.result?.metrics) {
    payload.metrics = {
      duration: input.result.metrics.duration,
      memoryUsed: input.result.metrics.memoryUsed ?? null,
    };
  }

  if (input.result?.error) {
    payload.error = {
      code: input.result.error.code,
      message: input.result.error.message,
    };
  }

  return payload;
}

export async function handleDeleteSession(
  request: Request,
  runtime: RuntimeStub,
): Promise<Response> {
  console.log("[api/delete-session] Handling session deletion request");

  try {
    const url = new URL(request.url);
    const sessionId = extractSessionIdFromPath(url.pathname);
    if (!sessionId || sessionId.length < 5) {
      console.warn(`[api/delete-session] Invalid session ID: ${sessionId}`);
      return errorResponse("Invalid session ID", "INVALID_REQUEST", 400);
    }

    const auth = await authorizeSessionRequest(request, runtime, sessionId);
    if (!auth.ok) {
      return auth.response;
    }

    const sessionStore = getRuntimeSessionStore(runtime);
    if (!sessionStore) {
      return errorResponse(
        "Session storage unavailable",
        "SESSION_STORAGE_UNAVAILABLE",
        503,
      );
    }

    const releaseLease = (runtime as LeaseRuntime).releaseLease;
    if (typeof releaseLease === "function") {
      await releaseLease(auth.session.lease.leaseId);
    }
    await sessionStore.deleteExecutionSession(sessionId);
    console.log(
      `[api/delete-session] Session deleted: ${sessionId.substring(0, 8)}...`,
    );

    return jsonResponse(
      {
        success: true,
        message: `Session ${sessionId} deleted successfully`,
      },
      200,
    );
  } catch (error) {
    const msg = sanitizeUnknownError(error);
    console.error(
      `[api/delete-session] Unexpected error: ${sanitizeLogText(msg)}`,
    );
    return errorResponse(msg, "INTERNAL_ERROR", 500);
  }
}

export async function addLog(
  runtime: RuntimeStub,
  sessionId: string,
  level: SessionLogEntry["level"],
  message: string,
  source?: SessionLogEntry["source"],
): Promise<void> {
  await recordLog(runtime, sessionId, level, message, source);
}

export async function getSession(
  runtime: RuntimeStub,
  sessionId: string,
): Promise<PublicSessionRecord | null> {
  const session = await getActiveSession(runtime, sessionId);
  if (!session) {
    return null;
  }
  const { token: _token, ...publicSession } = session;
  return publicSession;
}

export async function isSessionValid(
  runtime: RuntimeStub,
  sessionId: string,
): Promise<boolean> {
  const session = await getActiveSession(runtime, sessionId);
  return session !== null;
}
