/**
 * Shared HTTP response primitives for Brain controllers.
 *
 * Single Responsibility: Build consistent JSON responses with proper headers.
 * Avoids duplication of response construction logic across controllers.
 */

import { getCorsHeaders } from "../lib/cors";
import type { Env } from "../types/ai";
import { getBrainRuntimeHeaders } from "../core/observability/runtime";

const RUNTIME_HEADER_FORWARD_MAP = {
  "X-Shadowbox-Runtime-Boot-Id": "X-Shadowbox-Run-Engine-Boot-Id",
  "X-Shadowbox-Runtime-Fingerprint": "X-Shadowbox-Run-Engine-Fingerprint",
  "X-Shadowbox-Runtime-Git-Sha": "X-Shadowbox-Run-Engine-Git-Sha",
  "X-Shadowbox-Runtime-Name": "X-Shadowbox-Run-Engine-Name",
  "X-Shadowbox-Runtime-Started-At": "X-Shadowbox-Run-Engine-Started-At",
} as const;

/**
 * Build a successful JSON response with CORS headers.
 *
 * @param request - The incoming HTTP request (for CORS origin)
 * @param env - Cloudflare environment (for CORS configuration)
 * @param data - The response payload
 * @param options - Optional { status?: number, customHeaders?: Record<string, string> }
 * @returns Response with JSON body and CORS headers
 */
export function jsonResponse(
  request: Request,
  env: Env,
  data: unknown,
  options?: { status?: number; customHeaders?: Record<string, string> },
): Response {
  const status = options?.status ?? 200;
  const customHeaders = options?.customHeaders ?? {};

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...customHeaders,
      ...getBrainRuntimeHeaders(env),
      // CORS headers take precedence to prevent caller override of security headers
      ...getCorsHeaders(request, env),
    },
  });
}

export function noContentResponse(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...getBrainRuntimeHeaders(env),
      ...getCorsHeaders(request, env),
    },
  });
}

/**
 * Build an error JSON response with CORS headers.
 *
 * @param request - The incoming HTTP request (for CORS origin)
 * @param env - Cloudflare environment (for CORS configuration)
 * @param message - Error message to return
 * @param status - HTTP status code (default: 500)
 * @param code - Optional error code for categorization
 * @returns Response with error envelope and CORS headers
 */
export function errorResponse(
  request: Request,
  env: Env,
  message: string,
  status: number = 500,
  code?: string,
  metadata?: Record<string, unknown>,
): Response {
  if (metadata && !code) {
    throw new TypeError("errorResponse metadata requires an error code.");
  }

  const errorBody = code
    ? metadata
      ? { error: message, code, metadata }
      : { error: message, code }
    : { error: message };

  return new Response(JSON.stringify(errorBody), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getBrainRuntimeHeaders(env),
      ...getCorsHeaders(request, env),
    },
  });
}

/**
 * Add engine-specific headers to a response (runId, version, etc).
 *
 * @param request - The incoming HTTP request (for CORS origin)
 * @param env - Cloudflare environment (for CORS configuration)
 * @param response - The base response to enhance
 * @param runId - The run ID to include in headers
 * @returns New Response with engine headers merged with base response
 */
export function withEngineHeaders(
  request: Request,
  env: Env,
  response: Response,
  runId: string,
  runtime: string = response.headers.get("X-Run-Engine-Runtime") ?? "do",
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Engine-Version", "3.0");
  headers.set("X-Run-Id", runId);
  headers.set("X-Run-Engine-Runtime", runtime);
  forwardRunEngineRuntimeHeaders(response.headers, headers);
  const runtimeHeaders = getBrainRuntimeHeaders(env);
  Object.entries(runtimeHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const corsHeaders = getCorsHeaders(request, env);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function forwardRunEngineRuntimeHeaders(
  sourceHeaders: Headers,
  targetHeaders: Headers,
): void {
  for (const [sourceHeader, targetHeader] of Object.entries(
    RUNTIME_HEADER_FORWARD_MAP,
  )) {
    const value = sourceHeaders.get(sourceHeader);
    if (value) {
      targetHeaders.set(targetHeader, value);
    }
  }
}
