import {
  createLogger,
  parseTraceparent,
  type LogContext,
} from "@repo/observability";
import { resolveRuntimeGitSha } from "@repo/shared-types";
import type { Env } from "../../types/ai";

interface ReportBrainErrorInput {
  request: Request;
  operation: string;
  error: unknown;
  context?: LogContext;
}

/**
 * Canonical Brain error-reporting boundary. External sinks (Sentry/PostHog)
 * will attach here; application callers never know about a vendor SDK.
 */
export function reportBrainError(env: Env, input: ReportBrainErrorInput): void {
  const url = new URL(input.request.url);
  const trace = parseTraceparent(input.request.headers.get("traceparent"));
  const correlationId = input.request.headers.get("X-Correlation-Id");
  const logger = createLogger({
    service: "brain",
    environment: env.ENVIRONMENT ?? env.NODE_ENV ?? "unknown",
    release: resolveRuntimeGitSha(env as unknown as Record<string, unknown>),
    trace,
    context: {
      method: input.request.method,
      route: url.pathname,
      ...(correlationId ? { correlationId } : {}),
      ...(input.context ?? {}),
    },
  });

  logger.captureException(`${input.operation}.failed`, input.error, {
    operation: input.operation,
  });
}

export function getOrCreateCorrelationId(request: Request): string {
  return request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
}

export function withCorrelationId(
  request: Request,
  correlationId: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set("X-Correlation-Id", correlationId);
  return new Request(request, { headers });
}

export function withObservabilityHeaders(
  response: Response,
  correlationId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Correlation-Id", correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
