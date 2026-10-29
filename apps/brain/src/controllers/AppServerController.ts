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
import { composeHostedCodeArtifactReads } from "../integration/app-server/HostedCodeArtifactReads";
import { handleAppServerHttpRequest } from "@legioncode/app-server/server";

import { getCorsHeaders } from "../lib/cors";
import type { Env } from "../types/ai";

const MAX_REQUEST_BYTES = 32 * 1024;
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
    const authenticatedLargeBody = preferenceUpdate || largeThreadInput;
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
          },
        });
      }
    }
    const body = await readBoundedBody(request, authenticatedLargeBody ? null : MAX_REQUEST_BYTES);
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
    let hostedCodeArtifactReadsService: ReturnType<typeof composeHostedCodeArtifactReads> | undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(body.value); } catch { /* Dispatcher validates malformed input. */ }
    const parsed = AppServerRequestSchema.safeParse(envelope);
    if ((preferenceUpdate || largeThreadInput) &&
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
        hostedCodeArtifactReadsService = composeHostedCodeArtifactReads(env, auth.userId);
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
        hostedCodeArtifactReadsService,
      },
    );
    return json(env, request, result.statusCode, result.payload);
  },
};

function isArtifactReadMethod(method: string): boolean {
  return method === "artifact/reviewLatest" || method === "artifact/reviewByMessage" || method === "artifact/diff" || method === "artifact/codeContent";
}

function turnAuthFailureDetails(method: string, statusCode: number) {
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

function json(
  env: Env,
  request: Request,
  status: number,
  payload: unknown,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "application/json",
    },
  });
}
