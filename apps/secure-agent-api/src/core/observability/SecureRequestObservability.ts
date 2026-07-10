import {
  createLogger,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  type Logger,
} from "@repo/observability";
import { resolveRuntimeGitSha } from "@repo/shared-types";
import type { Env } from "../../index";

export interface SecureRequestContext {
  request: Request;
  correlationId: string;
}

/**
 * Establishes one request-scoped correlation and trace context at the worker
 * boundary. Downstream handlers receive the cloned request, so they cannot
 * accidentally invent competing request identities.
 */
export function createSecureRequestContext(
  request: Request,
): SecureRequestContext {
  const correlationId =
    request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  const trace =
    parseTraceparent(request.headers.get("traceparent")) ??
    createTraceContext();
  const headers = new Headers(request.headers);
  headers.set("X-Correlation-Id", correlationId);
  headers.set("traceparent", formatTraceparent(trace));

  return {
    correlationId,
    request: new Request(request, { headers }),
  };
}

export function createSecureRequestLogger(env: Env, request: Request): Logger {
  const url = new URL(request.url);
  return createLogger({
    service: "secure-agent-api",
    environment: env.ENVIRONMENT ?? "unknown",
    release: resolveRuntimeGitSha(env as unknown as Record<string, unknown>),
    trace: parseTraceparent(request.headers.get("traceparent")),
    context: {
      correlationId: request.headers.get("X-Correlation-Id") ?? "missing",
      method: request.method,
      route: url.pathname,
    },
  });
}

export function withSecureObservabilityHeaders(
  response: Response,
  request: Request,
): Response {
  const headers = new Headers(response.headers);
  const correlationId = request.headers.get("X-Correlation-Id");
  const traceparent = request.headers.get("traceparent");
  if (correlationId) headers.set("X-Correlation-Id", correlationId);
  if (traceparent) headers.set("traceparent", traceparent);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
