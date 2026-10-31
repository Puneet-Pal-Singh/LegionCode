import { composeHostedProviderPreferences } from "../integration/app-server/HostedProviderPreferences";
import { composeHostedProviderCredentials } from "../integration/app-server/HostedProviderCredentials";
import { composeHostedProviderDiscovery } from "../integration/app-server/HostedProviderDiscovery";
import { composeHostedWorkspaceSelection } from "../integration/app-server/HostedWorkspaceSelection";
import { APP_SERVER_PROTOCOL_VERSION, AppServerRequestSchema } from "@legioncode/app-server/protocol";
import { getAuthenticatedUserSession, isSessionStoreUnavailableError } from "../services/AuthService";
import { composeHostedSessionMetadata } from "../integration/app-server/HostedSessionMetadata";
import { composeHostedConversationHistory } from "../integration/app-server/HostedConversationHistory";
import { composeHostedTurnScope } from "../integration/app-server/HostedTurnScope";
import { composeHostedLifecycleOperations } from "../integration/app-server/HostedLifecycleOperations";
import { composeHostedTurnCommands } from "../integration/app-server/HostedTurnCommands";
import { composeHostedThreadInputOperations } from "../integration/app-server/HostedThreadInputOperations";
import { composeHostedSessionPullRequests } from "../integration/app-server/HostedSessionPullRequests";
import { composeHostedEditArtifactReads } from "../integration/app-server/HostedEditArtifactReads";
import { composeHostedRepositoryReads } from "../integration/app-server/HostedRepositoryReads";
import { AppServerOperationError, handleAppServerHttpRequest } from "@legioncode/app-server/server";
import type { AppServerError, ChatRequestBody, HostedChatSubmissionResult } from "@repo/platform-protocol";
import { bindAuthenticatedChatRequest } from "./ChatRequestBoundary";
import {
  hostedChatSubmissionResult,
  hostedChatSubmissionAckHeaders,
  scheduleHostedChatResponseDrain,
  submitHostedChat,
} from "../integration/app-server/HostedChatSubmission";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import { reportBrainError } from "../core/observability/BrainErrorReporter";

import { getCorsHeaders } from "../lib/cors";
import type { Env } from "../types/ai";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_TOTAL_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_SUBMISSION_BYTES =
  MAX_REQUEST_BYTES + 4 * Math.ceil(MAX_TOTAL_CHAT_IMAGE_BYTES / 3) + 4 * 256;
const LARGE_THREAD_INPUT_METHODS = new Set([
  "turn/steer",
  "thread/input/enqueue",
  "thread/input/update",
]);

export const AppServerController = {
  async request(request: Request, env: Env, executionContext?: ExecutionContext): Promise<Response> {
    // Visibility lists were uncapped on the existing authenticated BYOK route.
    // A routing hint permits that one body shape only after cookie validation;
    // the parsed method must match before dispatch. Other requests stay bounded.
    const methodHint = request.headers.get("X-LegionCode-AppServer-Method");
    const preferenceUpdate = methodHint === "provider/preferences/update";
    const largeThreadInput = methodHint !== null && LARGE_THREAD_INPUT_METHODS.has(methodHint);
    const chatSubmission = methodHint === "turn/submit";
    const authenticatedLargeBody = preferenceUpdate || largeThreadInput || chatSubmission;
    let earlyAuth: Awaited<ReturnType<typeof getAuthenticatedUserSession>> | undefined;
    if (authenticatedLargeBody) {
      try {
        earlyAuth = await getAuthenticatedUserSession(request, env);
        if (!earlyAuth) return json(env, request, 401, {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: methodHint,
          ok: false,
          error: {
            code: "unauthorized",
            message: "Unauthorized",
            ...(largeThreadInput ? { statusCode: 401, operationCode: "AUTH_FAILED", retryable: false } : {}),
            ...(chatSubmission ? turnAuthFailureDetails("turn/submit", 401) : {}),
          },
        });
      } catch (error) {
        const statusCode = largeThreadInput ? 500 : isSessionStoreUnavailableError(error) ? 503 : 500;
        return json(env, request, statusCode, {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: methodHint,
          ok: false,
          error: {
            code: "server_unavailable",
            message: largeThreadInput ? "Thread input operation failed" : "Authentication is unavailable",
            ...(largeThreadInput ? { statusCode, operationCode: "THREAD_INPUT_FAILED", retryable: true } : {}),
            ...(chatSubmission ? turnAuthFailureDetails("turn/submit", statusCode) : {}),
          },
        });
      }
    }
    const body = await readBoundedBody(
      request,
      chatSubmission ? MAX_CHAT_SUBMISSION_BYTES : authenticatedLargeBody ? null : MAX_REQUEST_BYTES,
    );
    if (body.oversized) {
      return json(env, request, 413, {
        code: "invalid_request",
        message: "App Server request is too large",
      });
    }
    // Initialize remains a public handshake. Resource services are composed only
    // after an HttpOnly cookie resolves to a server-verified principal.
    let hostedProviderCredentialService: ReturnType<typeof composeHostedProviderCredentials> | undefined;
    let hostedProviderPreferenceService: ReturnType<typeof composeHostedProviderPreferences> | undefined;
    let hostedProviderDiscoveryService: ReturnType<typeof composeHostedProviderDiscovery> | undefined;
    let hostedWorkspaceService: ReturnType<typeof composeHostedWorkspaceSelection> | undefined;
    let historyService: ReturnType<typeof composeHostedConversationHistory> | undefined;
    let sessionMetadataService: ReturnType<typeof composeHostedSessionMetadata> | undefined;
    let hostedSessionPullRequestService: ReturnType<typeof composeHostedSessionPullRequests> | undefined;
    let hostedTurnScopeService: ReturnType<typeof composeHostedTurnScope> | undefined;
    let hostedTurnCommandsService: ReturnType<typeof composeHostedTurnCommands> | undefined;
    let hostedThreadInputOperationsService: ReturnType<typeof composeHostedThreadInputOperations> | undefined;
    let hostedLifecycleOperationsService: ReturnType<typeof composeHostedLifecycleOperations> | undefined;
    let hostedEditArtifactReadsService: ReturnType<typeof composeHostedEditArtifactReads> | undefined;
    let hostedRepositoryReadService: ReturnType<typeof composeHostedRepositoryReads> | undefined;
    let hostedChatSubmissionService:
      | { execute(params: ChatRequestBody): Promise<HostedChatSubmissionResult> }
      | undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(body.value); } catch { /* Dispatcher validates malformed input. */ }
    const parsed = AppServerRequestSchema.safeParse(envelope);
    if ((preferenceUpdate || largeThreadInput || chatSubmission) &&
      (!parsed.success || parsed.data.method !== methodHint)) {
      return json(env, request, 400, { code: "invalid_request", message: "App Server method does not match the request routing hint" });
    }
    if (parsed.success && parsed.data.method !== "initialize") {
      try {
        const auth = earlyAuth ?? await getAuthenticatedUserSession(request, env);
        if (!auth) return json(env, request, 401, {
          protocolVersion: parsed.data.protocolVersion, method: parsed.data.method,
          ok: false, error: { code: "unauthorized", message: "Unauthorized", ...threadInputAuthFailureDetails(parsed.data.method, 401), ...turnAuthFailureDetails(parsed.data.method, 401) },
        });
        hostedProviderCredentialService = composeHostedProviderCredentials(request, env, auth.userId);
        hostedProviderPreferenceService = composeHostedProviderPreferences(request, env, auth.userId);
        hostedProviderDiscoveryService = composeHostedProviderDiscovery(request, env, auth.userId);
        hostedWorkspaceService = composeHostedWorkspaceSelection(request, env, auth.userId);
        historyService = composeHostedConversationHistory(env, auth.userId);
        sessionMetadataService = composeHostedSessionMetadata(env, auth.userId);
        hostedSessionPullRequestService = composeHostedSessionPullRequests(request, env, auth.userId);
        hostedTurnScopeService = composeHostedTurnScope(request, env, auth.userId);
        hostedTurnCommandsService = composeHostedTurnCommands(env, auth.userId);
        hostedThreadInputOperationsService = composeHostedThreadInputOperations(request, env, auth.userId, executionContext);
        hostedLifecycleOperationsService = composeHostedLifecycleOperations(request, env, auth.userId);
        hostedEditArtifactReadsService = composeHostedEditArtifactReads(env, auth.userId);
        hostedRepositoryReadService = composeHostedRepositoryReads(request, env, auth.userId);
        hostedChatSubmissionService = {
          execute: async (params) => {
            const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
            try {
              const chatRequest = await bindAuthenticatedChatRequest(request, env, params, correlationId, auth);
              const runtimeResponse = await submitHostedChat(request, chatRequest, env, undefined, executionContext);
              if (!runtimeResponse.ok) {
                const failure = await readHostedChatError(runtimeResponse);
                await drainHostedChatRuntimeResponse(runtimeResponse, executionContext);
                const statusCode = runtimeResponse.status >= 400 ? runtimeResponse.status : 502;
                throw new AppServerOperationError(
                  statusCode,
                  appServerErrorCode(statusCode),
                  failure.message ?? "Chat request failed",
                  failure.code,
                  statusCode >= 500 || statusCode === 408 || statusCode === 429,
                  correlationId,
                  failure.metadata,
                  hostedChatSubmissionAckHeaders(runtimeResponse),
                );
              }
              const result = hostedChatSubmissionResult(runtimeResponse);
              await drainHostedChatRuntimeResponse(runtimeResponse, executionContext);
              return result;
            } catch (error) {
              if (error instanceof AppServerOperationError) throw error;
              if (isDomainError(error)) {
                const mapped = mapDomainErrorToHttp(error);
                throw new AppServerOperationError(
                  mapped.status,
                  appServerErrorCode(mapped.status),
                  mapped.message,
                  mapped.code,
                  error.retryable,
                  error.correlationId ?? correlationId,
                  mapped.metadata,
                );
              }
              reportBrainError(env, { request, operation: "chat.request.execute", error, context: { correlationId } });
              throw new AppServerOperationError(
                500, "server_unavailable", "Internal Server Error", "CHAT_REQUEST_FAILED", false, correlationId,
              );
            }
          },
        };
      } catch (error) {
        const inputMethod = isThreadInputMethod(parsed.data.method);
        const sessionStoreUnavailable = isSessionStoreUnavailableError(error);
        const statusCode = inputMethod ? 500 : sessionStoreUnavailable ? 503 : 500;
        const message = inputMethod
          ? "Thread input operation failed"
          : isArtifactReadMethod(parsed.data.method) && sessionStoreUnavailable
            ? error.message
            : "Authentication is unavailable";
        return json(env, request, statusCode, {
          protocolVersion: parsed.data.protocolVersion, method: parsed.data.method,
          ok: false, error: {
            code: "server_unavailable",
            ...(inputMethod ? { statusCode, operationCode: "THREAD_INPUT_FAILED", retryable: true } : {}),
            message,
            ...turnAuthFailureDetails(parsed.data.method, statusCode),
          },
        });
      }
    }
    const result = await handleAppServerHttpRequest(
      {
        method: request.method,
        path: new URL(request.url).pathname,
        origin: request.headers.get("origin") ?? undefined,
        contentType: request.headers.get("content-type") ?? undefined,
        rawBody: body.value,
      },
      {
        environment: "hosted",
        serverId: "legioncode-hosted",
        serverVersion: "0.1.0",
        hostedWorkspaceService,
        hostedProviderDiscoveryService,
        hostedProviderPreferenceService,
        hostedProviderCredentialService,
        conversationHistoryService: historyService,
        sessionMetadataService,
        hostedSessionPullRequestService,
        hostedTurnScopeService,
        hostedTurnCommandsService,
        hostedThreadInputOperationsService,
        hostedLifecycleOperationsService,
        hostedEditArtifactReadsService,
        hostedRepositoryReadService,
        hostedChatSubmissionService,
      },
    );
    const submissionAck = parsed.success && parsed.data.method === "turn/submit"
      ? readSubmissionAck(result.payload)
      : undefined;
    return json(env, request, result.statusCode, result.payload, {
      ...result.headers,
      ...submissionAck,
    });
  },
};

function isArtifactReadMethod(method: string): boolean {
  return method === "artifact/reviewLatest" || method === "artifact/reviewByMessage" || method === "artifact/diff";
}

function turnAuthFailureDetails(method: string, statusCode: number) {
  if (method === "turn/submit") {
    return {
      statusCode,
      operationCode: statusCode === 401 ? "AUTH_FAILED" : statusCode === 503 ? "PROVIDER_UNAVAILABLE" : "CHAT_REQUEST_FAILED",
      retryable: statusCode >= 500 || statusCode === 408 || statusCode === 429,
    };
  }
  if (isArtifactReadMethod(method)) {
    return {
      statusCode,
      operationCode: statusCode === 401 ? "AUTH_FAILED" : "API_ERROR",
      retryable: statusCode >= 500 || statusCode === 408 || statusCode === 429,
    };
  }
  if (method === "turn/lifecycleEvents" || method === "turn/diff" || method === "turn/approval" || method === "turn/compact" || method === "turn/interrupt") {
    return {
      statusCode,
      operationCode: "API_ERROR",
      retryable: statusCode >= 500 || statusCode === 408 || statusCode === 429,
    };
  }
  if (method !== "turn/reserve" && method !== "turn/scope") return {};
  return {
    statusCode,
    operationCode: statusCode === 401 ? "AUTH_FAILED" : "AUTH_SESSION_STORE_UNAVAILABLE",
    retryable: statusCode >= 500 || statusCode === 408 || statusCode === 429,
  };
}

function isThreadInputMethod(method: string): boolean {
  return method === "turn/steer" || method === "turn/resume" ||
    method.startsWith("thread/input/");
}

function threadInputAuthFailureDetails(method: string, statusCode: number) {
  if (!isThreadInputMethod(method)) return {};
  return {
    statusCode,
    operationCode: statusCode === 401 ? "AUTH_FAILED" : "THREAD_INPUT_FAILED",
    retryable: statusCode >= 500,
  };
}

async function readBoundedBody(
  request: Request,
  maxBytes: number | null,
): Promise<{ value: string; oversized: boolean }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (maxBytes !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await request.body?.cancel();
    return { value: "", oversized: true };
  }
  if (!request.body) return { value: "", oversized: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (maxBytes !== null && size > maxBytes) {
      await reader.cancel();
      return { value: "", oversized: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(bytes), oversized: false };
  } catch {
    return { value: "\u0000", oversized: false };
  }
}

function appServerErrorCode(statusCode: number): AppServerError["code"] {
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) return "forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 409) return "conflict";
  if (statusCode >= 500) return "server_unavailable";
  return "invalid_request";
}

async function readHostedChatError(response: Response): Promise<{
  message?: string;
  code?: string;
  metadata?: Record<string, unknown>;
}> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const metadata = record.metadata;
  return {
    ...(typeof record.error === "string"
      ? { message: record.error }
      : typeof record.message === "string"
        ? { message: record.message }
        : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
  };
}

async function drainHostedChatRuntimeResponse(
  response: Response,
  executionContext?: ExecutionContext,
): Promise<void> {
  if (executionContext) {
    scheduleHostedChatResponseDrain(response, executionContext);
    return;
  }
  await response.arrayBuffer().catch((error: unknown) => {
    console.error("[chat/runtime] App Server response drain failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function readSubmissionAck(payload: unknown): Record<string, string> | undefined {
  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true || !("result" in payload)) {
    return undefined;
  }
  const result = payload.result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as Partial<HostedChatSubmissionResult>;
  return {
    ...(record.runId !== undefined && record.runId !== null ? { "X-Run-Id": record.runId } : {}),
    ...(record.threadId !== undefined && record.threadId !== null ? { "X-Thread-Id": record.threadId } : {}),
    ...(record.turnId !== undefined && record.turnId !== null ? { "X-Turn-Id": record.turnId } : {}),
    ...(record.runAttemptId !== undefined && record.runAttemptId !== null ? { "X-Run-Attempt-Id": record.runAttemptId } : {}),
  };
}

function json(
  env: Env,
  request: Request,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
