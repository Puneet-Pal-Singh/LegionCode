import {
  ApprovalIdSchema,
  ApprovalDecisionSchema,
  runIdFromTurnId,
} from "@repo/platform-protocol";
import { fetchRunRuntimeRoute } from "./chat-runtime-helpers";
import type { Env } from "../types/ai";
import { getCorsHeaders } from "../lib/cors";
import { getBrainRuntimeHeaders } from "../core/observability/runtime";
import {
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";

type RuntimeOrchestratorBackend = Parameters<typeof fetchRunRuntimeRoute>[2];

export class LifecycleController {
  static async getEvents(request: Request, env: Env): Promise<Response> {
    return await proxyLifecycleRequest(request, env, "GET", "replay");
  }

  static async getTurnDiff(request: Request, env: Env): Promise<Response> {
    return await proxyLifecycleRequest(request, env, "GET", "diff");
  }

  static async submitApproval(request: Request, env: Env): Promise<Response> {
    return await proxyLifecycleApprovalRequest(request, env);
  }

  static async compact(request: Request, env: Env): Promise<Response> {
    return await proxyLifecycleCommandRequest(request, env, "compact");
  }
}

type LifecycleProxyMode = "replay" | "diff";

async function proxyLifecycleCommandRequest(
  request: Request,
  env: Env,
  command: "compact",
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/turns\/([^/]+)\/compact$/);
    const turnId = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (!turnId) return errorResponse(request, env, "turnId is required", 400);
    const auth = await getAuthenticatedUserSession(request, env);
    if (!auth) return errorResponse(request, env, "Unauthorized", 401);
    const runId = runIdFromTurnId(turnId);
    if (!(await verifyRunOwnership(env, runId, auth.userId))) {
      return errorResponse(request, env, "Run not found", 404);
    }
    const body = await request.json();
    const response = await fetchRunRuntimeRoute(env, runId, readBackend(url), {
      method: "POST",
      path: `/${command}`,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return proxyResponse(request, env, response);
  } catch (error) {
    if (isSessionStoreUnavailableError(error)) {
      return errorResponse(request, env, error.message, 503);
    }
    return errorResponse(
      request,
      env,
      error instanceof Error ? error.message : "Failed to compact context",
      500,
    );
  }
}

async function proxyLifecycleRequest(
  request: Request,
  env: Env,
  method: "GET",
  mode: LifecycleProxyMode,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const turnId = readTurnIdFromPublicPath(url.pathname);
    if (!turnId) {
      return errorResponse(request, env, "turnId is required", 400);
    }

    const auth = await getAuthenticatedUserSession(request, env);
    if (!auth) {
      return errorResponse(request, env, "Unauthorized", 401);
    }

    const runId = runIdFromTurnId(turnId);
    const ownsRun = await verifyRunOwnership(env, runId, auth.userId);
    if (!ownsRun) {
      return errorResponse(request, env, "Run not found", 404);
    }

    const response = await fetchRunRuntimeRoute(env, runId, readBackend(url), {
      method,
      path: buildRuntimeLifecyclePath(mode, turnId, url.searchParams),
    });
    return proxyResponse(request, env, response);
  } catch (error) {
    if (isSessionStoreUnavailableError(error)) {
      return errorResponse(request, env, error.message, 503);
    }
    return errorResponse(
      request,
      env,
      error instanceof Error ? error.message : "Failed to fetch lifecycle",
      500,
    );
  }
}

async function proxyLifecycleApprovalRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = readApprovalRouteFromPublicPath(url.pathname);
    if (!route) {
      return errorResponse(request, env, "turnId and approvalId are required", 400);
    }

    const auth = await getAuthenticatedUserSession(request, env);
    if (!auth) {
      return errorResponse(request, env, "Unauthorized", 401);
    }

    const body = await request.json();
    const payload = parseLifecycleApprovalPayload(body, route);
    if (!payload.ok) {
      return errorResponse(request, env, payload.message, 400);
    }

    const runId = runIdFromTurnId(route.turnId);
    const ownsRun = await verifyRunOwnership(env, runId, auth.userId);
    if (!ownsRun) {
      return errorResponse(request, env, "Run not found", 404);
    }

    const params = new URLSearchParams({
      turnId: route.turnId,
      approvalId: route.approvalId,
    });
    const response = await fetchRunRuntimeRoute(env, runId, readBackend(url), {
      method: "POST",
      path: `/lifecycle-approval?${params.toString()}`,
      body: JSON.stringify(payload.value),
      headers: { "Content-Type": "application/json" },
    });
    return proxyResponse(request, env, response);
  } catch (error) {
    if (isSessionStoreUnavailableError(error)) {
      return errorResponse(request, env, error.message, 503);
    }
    return errorResponse(
      request,
      env,
      error instanceof Error ? error.message : "Failed to submit approval",
      500,
    );
  }
}

async function verifyRunOwnership(
  env: Env,
  runId: string,
  userId: string,
): Promise<boolean> {
  return await withRunRepository(env, async (repository) => {
    return Boolean(await repository.getRun(runId, userId));
  });
}

function buildRuntimeLifecyclePath(
  mode: LifecycleProxyMode,
  turnId: string,
  searchParams: URLSearchParams,
): string {
  const params = new URLSearchParams();
  params.set("turnId", turnId);
  copyParam(searchParams, params, "afterSequence");
  copyParam(searchParams, params, "limit");
  if (mode === "diff") {
    return `/turn-diff?${params.toString()}`;
  }
  return `/lifecycle-events?${params.toString()}`;
}

function copyParam(
  source: URLSearchParams,
  target: URLSearchParams,
  name: string,
): void {
  const value = source.get(name);
  if (value !== null) {
    target.set(name, value);
  }
}

function readBackend(url: URL): RuntimeOrchestratorBackend {
  return url.searchParams.get("backend") === "cloudflare_agents"
    ? "cloudflare_agents"
    : "execution-engine-v1";
}

function readTurnIdFromPublicPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/turns\/([^/]+)\/(?:lifecycle-events|diff)$/,
  );
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readApprovalRouteFromPublicPath(
  pathname: string,
): { turnId: string; approvalId: string } | null {
  const match = pathname.match(/^\/turns\/([^/]+)\/approvals\/([^/]+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    turnId: decodeURIComponent(match[1]),
    approvalId: decodeURIComponent(match[2]),
  };
}

function parseLifecycleApprovalPayload(
  body: unknown,
  route: { turnId: string; approvalId: string },
):
  | {
      ok: true;
      value: {
        turnId: string;
        approvalId: string;
        decision: "approved" | "denied" | "cancelled";
        decidedBy: string | null;
        reason: string | null;
      };
    }
  | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Invalid approval payload" };
  }
  const record = body as Record<string, unknown>;
  const parsedTurnId = parseRouteValue(route.turnId, record.turnId, "turnId");
  if (!parsedTurnId.ok) return parsedTurnId;
  const parsedApprovalId = parseRouteValue(
    route.approvalId,
    record.approvalId,
    "approvalId",
  );
  if (!parsedApprovalId.ok) return parsedApprovalId;
  const decision = ApprovalDecisionSchema.safeParse(record.decision);
  if (!decision.success) {
    return { ok: false, message: "Invalid approval decision" };
  }
  return {
    ok: true,
    value: {
      turnId: parsedTurnId.value,
      approvalId: ApprovalIdSchema.parse(parsedApprovalId.value),
      decision: decision.data,
      decidedBy:
        typeof record.decidedBy === "string" ? record.decidedBy : null,
      reason: typeof record.reason === "string" ? record.reason : null,
    },
  };
}

function parseRouteValue(
  routeValue: string,
  bodyValue: unknown,
  field: "turnId" | "approvalId",
): { ok: true; value: string } | { ok: false; message: string } {
  if (bodyValue !== undefined && bodyValue !== routeValue) {
    return { ok: false, message: `${field} does not match route` };
  }
  return { ok: true, value: routeValue };
}

function proxyResponse(
  request: Request,
  env: Env,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(getCorsHeaders(request, env))) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(getBrainRuntimeHeaders(env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(
  request: Request,
  env: Env,
  message: string,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      ...getBrainRuntimeHeaders(env),
      "Content-Type": "application/json",
    },
  });
}
