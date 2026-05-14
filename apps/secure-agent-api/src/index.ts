// import { AgentRuntime } from "./core/AgentRuntime";
// import { Sandbox } from '@cloudflare/sandbox';

// export { Sandbox };
// export { AgentRuntime };

// export interface Env {
//   AGENT_RUNTIME: DurableObjectNamespace<AgentRuntime>;
//   Sandbox: DurableObjectNamespace<Sandbox>;
// }

// export default {
//   async fetch(request: Request, env: Env): Promise<Response> {
//     const url = new URL(request.url);

//     // ROUTE 0: WebSocket Connect
//     if (url.pathname === "/connect") {
//       const sessionId = url.searchParams.get("session") || "default";
//       const id = env.AGENT_RUNTIME.idFromName(sessionId);
//       const stub = env.AGENT_RUNTIME.get(id);

//       // Pass the Upgrade request to the Durable Object
//       return stub.fetch(request);
//     }

//     // ROUTE 1: Tool Discovery (GET /tools)
//     if (request.method === "GET" && url.pathname === "/tools") {
//       // We create a temporary ID just to query the schema.
//       // Since the schema is code-defined, any instance will return the same result.
//       const id = env.AGENT_RUNTIME.idFromName("system-registry");
//       const stub = env.AGENT_RUNTIME.get(id);

//       const tools = await stub.getManifest();

//       return Response.json({
//         runtime: "agent-runtime-cf",
//         version: "1.0.0",
//         endpoints: {
//           execute: "POST /?session={id}",
//           discovery: "GET /tools"
//         },
//         tools: tools
//       });
//     }

//     // ROUTE 2: Execution (POST /)
//     if (request.method === "POST") {
//       const sessionId = url.searchParams.get("session") || "default";
//       const id = env.AGENT_RUNTIME.idFromName(sessionId);
//       const stub = env.AGENT_RUNTIME.get(id);

//       const body = await request.json() as { plugin: string; payload: any };

//       if (!body.plugin) {
//         return Response.json({ error: "Missing 'plugin' field" }, { status: 400 });
//       }

//       const result = await stub.run(body.plugin, body.payload);
//       return Response.json(result);
//     }

//     // Default: 405 Method Not Allowed
//     return new Response("Method not allowed. Use POST for execution or GET /tools for discovery.", { status: 405 });
//   },
// };

// // src/index.ts
// import { AgentRuntime } from "./core/AgentRuntime";
// import { Sandbox } from '@cloudflare/sandbox';

// export { Sandbox, AgentRuntime };

// const corsHeaders = {
//   "Access-Control-Allow-Origin": "http://localhost:5173", // Tighten this later
//   "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
//   "Access-Control-Allow-Headers": "Content-Type",
//   "Access-Control-Allow-Credentials": "true"
// };

// export default {
//   async fetch(request: Request, env: any): Promise<Response> {
//     const url = new URL(request.url);

//     // 1. Handle CORS Preflight
//     if (request.method === "OPTIONS") {
//       return new Response(null, { headers: corsHeaders });
//     }

//     // 2. Route WebSocket
//     if (url.pathname === "/connect") {
//       const sessionId = url.searchParams.get("session") || "default";
//       const id = env.AGENT_RUNTIME.idFromName(sessionId);
//       return env.AGENT_RUNTIME.get(id).fetch(request);
//     }

//     // 3. Handle Routes
//     let response: Response;
//     try {
//       if (url.pathname === "/tools") {
//         const id = env.AGENT_RUNTIME.idFromName("system-registry");
//         const tools = await env.AGENT_RUNTIME.get(id).getManifest();
//         response = Response.json({ tools });
//       }
//       else if (request.method === "POST") {
//         const sessionId = url.searchParams.get("session") || "default";
//         const body = await request.json() as { plugin: string; payload: any };
//         const id = env.AGENT_RUNTIME.idFromName(sessionId);
//         const result = await env.AGENT_RUNTIME.get(id).run(body.plugin, body.payload);
//         response = Response.json(result);
//       }
//       else {
//         response = new Response("Not Found", { status: 404 });
//       }
//     } catch (e: any) {
//       response = Response.json({ error: e.message }, { status: 500 });
//     }

//     // Apply CORS headers to all responses
//     Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
//     return response;
//   },
// };

// solid compliant
// apps/secure-agent-api/src/index.ts
import { AgentRuntime } from "./core/AgentRuntime";
import { Sandbox } from "@cloudflare/sandbox";
import { LaunchRateLimiter } from "./runtime/LaunchRateLimiter";
import {
  handleCreateSession,
  handleExecuteTask,
  handleStreamLogs,
  handleDeleteSession,
} from "./api/SessionAPI";
import { getCorsHeaders, handleCorsPreflight } from "./lib/cors";
import { sanitizeUnknownError } from "./core/security/LogSanitizer";
import {
  buildSecureRuntimeDebugPayload,
  getSecureRuntimeHeaders,
} from "./core/observability/runtime";
import {
  ChatHistoryQuerySchema,
  ChatAppendRequestSchema,
  validateQueryParams,
  validateRequestBody,
  errorResponse,
} from "./schemas/http-api";
import { composeRuntime } from "./factories/RuntimeCompositionFactory";
import { enforceLaunchSafetyForRoute } from "./services/LaunchSafetyService";
import { InternalRuntimeEventClient } from "./services/runtime-events/InternalRuntimeEventClient";

export { Sandbox, AgentRuntime, LaunchRateLimiter, composeRuntime };

/**
 * SRP: Separate Environment definition
 */
export interface Env {
  AGENT_RUNTIME: DurableObjectNamespace<AgentRuntime>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  ARTIFACTS: R2Bucket;
  CORS_ALLOWED_ORIGINS?: string;
  CORS_ALLOW_DEV_ORIGINS?: "true" | "false";
  RUNTIME_GIT_SHA?: string;
  LAUNCH_RATE_LIMITER?: DurableObjectNamespace;
  LAUNCH_EMERGENCY_SHUTOFF_MODE?: "off" | "block_session_and_execute" | "block_all";
  LAUNCH_RATE_LIMIT_REQUIRED?: "true" | "false";
  BRAIN?: Fetcher;
  INTERNAL_RUNTIME_EVENT_SECRET?: string;
  SESSION_CREATE_RATE_LIMIT_AUTH_MAX?: string;
  SESSION_CREATE_RATE_LIMIT_ANON_MAX?: string;
  SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS?: string;
  EXECUTE_TASK_RATE_LIMIT_AUTH_MAX?: string;
  EXECUTE_TASK_RATE_LIMIT_ANON_MAX?: string;
  EXECUTE_TASK_RATE_LIMIT_WINDOW_SECONDS?: string;
}

/**
 * SRP: Extract shared POST append handler to eliminate duplication
 * Used by both canonical and legacy chat history routes
 */
async function handleChatAppend(
  request: Request,
  stub: DurableObjectStub<AgentRuntime>,
  runId: string,
): Promise<Response> {
  const bodyValidation = await validateRequestBody(
    request,
    ChatAppendRequestSchema,
  );
  if (!bodyValidation.valid) {
    return errorResponse(bodyValidation.error, "VALIDATION_ERROR", 400);
  }

  const { message, messages, idempotencyKey } = bodyValidation.data;
  const requestIdempotencyKey =
    idempotencyKey || request.headers.get("X-Idempotency-Key") || undefined;

  if (message) {
    await stub.appendMessage(runId, message, requestIdempotencyKey);
  } else if (messages) {
    await stub.saveHistory(runId, messages, requestIdempotencyKey);
  }

  return Response.json({ success: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const preflightResponse = handleCorsPreflight(request, env);
    if (preflightResponse) {
      return preflightResponse;
    }

    // 2. Identify the Session (Multi-Agent Support)
    const sessionId = url.searchParams.get("session") || "default";
    const id = env.AGENT_RUNTIME.idFromName(sessionId);
    const stub = env.AGENT_RUNTIME.get(id);

    try {
      // 3. Route to proper Durable Object methods
      let response: Response;

      if (url.pathname === "/api/debug/runtime" && request.method === "GET") {
        response = Response.json(buildSecureRuntimeDebugPayload(env));
      } else if (
        url.pathname === "/api/v1/session" &&
        request.method === "POST"
      ) {
        // NEW: HTTP API Routes for CloudSandboxExecutor Integration
        const safetyResponse = await enforceLaunchSafetyForRoute(
          request,
          env,
          "session_create",
        );
        if (safetyResponse) {
          response = safetyResponse;
        } else {
          response = await handleCreateSession(request, stub);
        }
      } else if (
        url.pathname === "/api/v1/execute" &&
        request.method === "POST"
      ) {
        const safetyResponse = await enforceLaunchSafetyForRoute(
          request,
          env,
          "execute_task",
        );
        if (safetyResponse) {
          response = safetyResponse;
        } else {
          response = await handleExecuteTask(
            request,
            stub,
            createRuntimeEventClient(env),
          );
        }
      } else if (url.pathname === "/api/v1/logs" && request.method === "GET") {
        response = await handleStreamLogs(
          request,
          stub,
          getCorsHeaders(request, env),
        );
      } else if (
        url.pathname.startsWith("/api/v1/session/") &&
        request.method === "DELETE"
      ) {
        response = await handleDeleteSession(request, stub);
      } else if (url.pathname === "/connect") {
        // Upgrade to WebSocket
        return stub.fetch(request);
      } else if (url.pathname === "/tools") {
        // Dynamic Tool Discovery for the Brain
        const tools = await stub.getManifest();
        response = Response.json({ tools });
      } else {
        const historyMatch = url.pathname.match(
          /^\/api\/chat\/history\/([^/]+)$/,
        );
        if (historyMatch) {
          // CANONICAL: GET /api/chat/history/:runId and POST /api/chat/history/:runId
          const runId = decodeURIComponent(historyMatch[1]!);

          if (request.method === "GET") {
            // Validate query parameters (cursor is optional, limit has defaults)
            const cursor = url.searchParams.get("cursor") || undefined;
            const limitStr = url.searchParams.get("limit") || "50";
            const limitNum = parseInt(limitStr, 10);
            const limit = Number.isNaN(limitNum)
              ? 50
              : Math.min(Math.max(1, limitNum), 100);

            const historyResult = await stub.getHistory(runId, cursor, limit);
            response = Response.json(historyResult);
          } else if (request.method === "POST") {
            // CANONICAL POST: Append message(s) to history (uses shared handler)
            response = await handleChatAppend(request, stub, runId);
          } else {
            response = new Response("Method Not Allowed", { status: 405 });
          }
        } else if (url.pathname === "/chat") {
          // LEGACY (deprecated): Keep for compatibility window
          // TODO: Remove in M1.3c (target: March 2026)
          console.warn(
            "[secure-api] /chat endpoint is deprecated; use GET /api/chat/history/:runId instead",
          );
          const queryValidation = validateQueryParams(
            url,
            ChatHistoryQuerySchema,
          );
          if (!queryValidation.valid) {
            response = errorResponse(
              queryValidation.error,
              "VALIDATION_ERROR",
              400,
            );
          } else {
            const { runId, cursor, limit } = queryValidation.data;

            if (request.method === "GET") {
              const historyResult = await stub.getHistory(runId, cursor, limit);
              response = Response.json(historyResult);
            } else if (request.method === "POST") {
              response = await handleChatAppend(request, stub, runId);
            } else {
              response = new Response("Method Not Allowed", { status: 405 });
            }
          }
        } else if (url.pathname === "/artifact") {
          const key = url.searchParams.get("key");
          if (!key) {
            response = new Response("Missing artifact key", { status: 400 });
          } else {
            const content = await stub.getArtifact(key);
            if (content === null) {
              response = new Response("Artifact not found", { status: 404 });
            } else {
              response = new Response(content, { status: 200 });
            }
          }
        } else {
          response = new Response("Route Not Found", { status: 404 });
        }
      }

      // 4. Final step: Inject CORS into the generated response
      const finalResponse = new Response(response.body, response);
      const corsHeaders = getCorsHeaders(request, env);
      for (const [k, v] of Object.entries(corsHeaders)) {
        finalResponse.headers.set(k, v);
      }
      const runtimeHeaders = getSecureRuntimeHeaders(env);
      for (const [k, v] of Object.entries(runtimeHeaders)) {
        finalResponse.headers.set(k, v);
      }
      return finalResponse;
    } catch (e: unknown) {
      const error = sanitizeUnknownError(e);
      const headers = {
        ...getCorsHeaders(request, env),
        ...getSecureRuntimeHeaders(env),
      };
      return Response.json({ error }, { status: 500, headers });
    }
  },
};

function createRuntimeEventClient(env: Env): InternalRuntimeEventClient {
  const secret = env.INTERNAL_RUNTIME_EVENT_SECRET?.trim();
  if (!env.BRAIN || !secret) {
    throw new Error(
      "BRAIN binding and INTERNAL_RUNTIME_EVENT_SECRET are required for runtime event emission",
    );
  }

  return new InternalRuntimeEventClient({
    brain: env.BRAIN,
    secret,
  });
}
