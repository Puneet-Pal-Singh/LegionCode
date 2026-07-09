import { getRunEngineRuntimeHeaders } from "../core/observability/runtime";
import { getCorsHeaders } from "../lib/cors";
import type { Env } from "../types/ai";

export function runEngineJsonResponse(
  request: Request,
  env: Env,
  data: unknown,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getRunEngineRuntimeHeaders(env),
      ...getCorsHeaders(request, env),
    },
  });
}

export function runEngineErrorResponse(
  request: Request,
  env: Env,
  message: string,
  status: number = 500,
  code?: string,
  metadata?: Record<string, unknown>,
): Response {
  if (metadata && !code) {
    throw new TypeError(
      "runEngineErrorResponse metadata requires an error code.",
    );
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
      ...getRunEngineRuntimeHeaders(env),
      ...getCorsHeaders(request, env),
    },
  });
}

export function withRunEngineHeaders(
  request: Request,
  env: Env,
  response: Response,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);

  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }

  const runtimeHeaders = getRunEngineRuntimeHeaders(env);
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
