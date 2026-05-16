import type { Env } from "../types/ai";
import {
  ApprovalDecisionKindSchema,
  type ApprovalDecisionKind,
  parseActivityFeedSnapshot,
} from "@repo/shared-types";
import { z } from "zod";
import { getCorsHeaders } from "../lib/cors";
import { getBrainRuntimeHeaders } from "../core/observability/runtime";
import { fetchRunRuntimeRoute } from "./chat-runtime-helpers";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";

type RuntimeOrchestratorBackend = "execution-engine-v1" | "cloudflare_agents";
const RuntimeOrchestratorBackendSchema = z.enum([
  "execution-engine-v1",
  "cloudflare_agents",
]);
const ApproveRunRequestSchema = z.object({
  runId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  decision: ApprovalDecisionKindSchema,
  orchestratorBackend: RuntimeOrchestratorBackendSchema.optional(),
});

interface RunSummaryResponse {
  runId: string;
  status: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  pendingTasks: number;
  cancelledTasks: number;
  eventCount?: number;
  lastEventType?: string | null;
  permissionContext?: unknown;
  pendingApproval?: unknown;
}

export class RunController {
  static async getSummary(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId")?.trim();
      const requestedBackend = parseRequestedBackend(
        url.searchParams.get("backend"),
      );

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      // PR6: Hydrate summary from Postgres
      const summary = await withRunRepository(env, async (repo) => {
        const run = await repo.getRun(runId);
        if (!run) return null;

        return {
          runId: run.id,
          status: run.status,
          totalTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          runningTasks: 0,
          pendingTasks: 0,
          cancelledTasks: 0,
        };
      });

      if (summary) {
        return jsonResponse(req, env, summary);
      }

      const response = await fetchRunSummaryFromRuntime(
        env,
        runId,
        requestedBackend,
      );
      if (!response.ok) {
        const details = await readErrorPreview(response);
        const suffix = details ? `: ${details}` : "";
        return errorResponse(
          req,
          env,
          `Failed to fetch run summary${suffix}`,
          response.status,
        );
      }

      const payload = (await response.json()) as RunSummaryResponse;
      return jsonResponse(req, env, payload);
    } catch (error) {
      console.error("[RunController:getSummary] Error:", error);
      return errorResponse(
        req,
        env,
        error instanceof Error ? error.message : "Failed to fetch run summary",
        500,
      );
    }
  }

  static async cancel(req: Request, env: Env): Promise<Response> {
    try {
      const body = (await req.json().catch(() => null)) as {
        runId?: string;
        orchestratorBackend?: RuntimeOrchestratorBackend;
      } | null;
      const runId = body?.runId?.trim();
      const requestedBackend =
        body?.orchestratorBackend ?? "execution-engine-v1";
      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      const response = await fetchRunCancelFromRuntime(
        env,
        runId,
        requestedBackend,
      );
      if (!response.ok) {
        const details = await readErrorPreview(response);
        const suffix = details ? `: ${details}` : "";
        return errorResponse(
          req,
          env,
          `Failed to cancel run${suffix}`,
          response.status,
        );
      }

      const payload = (await response.json()) as unknown;
      return jsonResponse(req, env, payload);
    } catch (error) {
      console.error("[RunController:cancel] Error:", error);
      return errorResponse(
        req,
        env,
        error instanceof Error ? error.message : "Failed to cancel run",
        500,
      );
    }
  }

  static async approve(req: Request, env: Env): Promise<Response> {
    try {
      const payload = await parseApproveRequest(req);
      const responsePayload = await resolveApprovalFromRuntime(env, payload);
      return jsonResponse(req, env, responsePayload);
    } catch (error) {
      if (error instanceof ApproveRequestError) {
        return errorResponse(req, env, error.message, error.status);
      }
      if (isStaleApprovalResolutionError(error)) {
        return errorResponse(req, env, "No pending approval request found.", 409);
      }
      console.error("[RunController:approve] Error:", error);
      return errorResponse(
        req,
        env,
        error instanceof Error ? error.message : "Failed to resolve approval",
        500,
      );
    }
  }

  static async getEvents(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId")?.trim();
      const requestedBackend = parseRequestedBackend(
        url.searchParams.get("backend"),
      );

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      // PR6: Fetch events from Postgres
      const events = await withRunRepository(env, async (repo) => {
        return await repo.listRunEvents(runId);
      });

      if (events.length > 0) {
        return jsonResponse(req, env, events);
      }

      const response = await fetchRunEventsFromRuntime(
        env,
        runId,
        requestedBackend,
      );
      if (!response.ok) {
        const details = await readErrorPreview(response);
        const suffix = details ? `: ${details}` : "";
        return errorResponse(
          req,
          env,
          `Failed to fetch run events${suffix}`,
          response.status,
        );
      }

      return proxyResponse(req, env, response);
    } catch (error) {
      console.error("[RunController:getEvents] Error:", error);
      return errorResponse(
        req,
        env,
        error instanceof Error ? error.message : "Failed to fetch run events",
        500,
      );
    }
  }

  static async getEventsStream(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId")?.trim();
      const requestedBackend = parseRequestedBackend(
        url.searchParams.get("backend"),
      );

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      const response = await fetchRunEventsStreamFromRuntime(
        env,
        runId,
        requestedBackend,
      );
      if (!response.ok) {
        const details = await readErrorPreview(response);
        const suffix = details ? `: ${details}` : "";
        return errorResponse(
          req,
          env,
          `Failed to stream run events${suffix}`,
          response.status,
        );
      }

      return proxyResponse(req, env, response);
    } catch (error) {
      console.error("[RunController:getEventsStream] Error:", error);
      return errorResponse(
        req,
        env,
        error instanceof Error ? error.message : "Failed to stream run events",
        500,
      );
    }
  }

  static async getActivity(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId")?.trim();
      const requestedBackend = parseRequestedBackend(
        url.searchParams.get("backend"),
      );

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      const response = await fetchRunActivityFromRuntime(
        env,
        runId,
        requestedBackend,
      );
      if (!response.ok) {
        const details = await readErrorPreview(response);
        const suffix = details ? `: ${details}` : "";
        return errorResponse(
          req,
          env,
          `Failed to fetch run activity${suffix}`,
          response.status,
        );
      }

      const payload = parseActivityFeedSnapshot(await response.json());
      return jsonResponse(req, env, payload);
    } catch (error) {
      console.error("[RunController:getActivity] Error:", error);
      return errorResponse(
        req,
        env,
        error instanceof Error ? error.message : "Failed to fetch run activity",
        500,
      );
    }
  }
}

async function fetchRunSummaryFromRuntime(
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "GET",
    path: `/summary?runId=${encodeURIComponent(runId)}`,
  });
}

async function fetchRunCancelFromRuntime(
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "POST",
    path: "/cancel",
    body: JSON.stringify({ runId }),
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function fetchRunApprovalFromRuntime(
  env: Env,
  runId: string,
  requestId: string,
  decision: ApprovalDecisionKind,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "POST",
    path: "/approval",
    body: JSON.stringify({ runId, requestId, decision }),
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function parseApproveRequest(req: Request): Promise<
  z.infer<typeof ApproveRunRequestSchema> & {
    requestedBackend: RuntimeOrchestratorBackend;
  }
> {
  const body = await req.json().catch(() => null);
  const parsed = ApproveRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApproveRequestError(
      "runId, requestId, and decision are required",
      400,
    );
  }

  return {
    ...parsed.data,
    requestedBackend: parsed.data.orchestratorBackend ?? "execution-engine-v1",
  };
}

async function resolveApprovalFromRuntime(
  env: Env,
  payload: z.infer<typeof ApproveRunRequestSchema> & {
    requestedBackend: RuntimeOrchestratorBackend;
  },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchRunApprovalFromRuntime(
      env,
      payload.runId,
      payload.requestId,
      payload.decision,
      payload.requestedBackend,
    );
  } catch (error) {
    if (isStaleApprovalResolutionError(error)) {
      throw new ApproveRequestError("No pending approval request found.", 409);
    }
    throw error;
  }
  if (!response.ok) {
    const details = await readErrorPreview(response);
    if (isStaleApprovalResolutionError(details)) {
      throw new ApproveRequestError("No pending approval request found.", 409);
    }
    const suffix = details ? `: ${details}` : "";
    throw new ApproveRequestError(
      `Failed to resolve approval${suffix}`,
      response.status,
    );
  }

  return (await response.json()) as unknown;
}

class ApproveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApproveRequestError";
  }
}

function isStaleApprovalResolutionError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return message.includes("no pending approval request found");
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "error" in error) {
    const candidate = (error as { error?: unknown }).error;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

async function fetchRunEventsFromRuntime(
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "GET",
    path: `/events?runId=${encodeURIComponent(runId)}`,
  });
}

async function fetchRunEventsStreamFromRuntime(
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "GET",
    path: `/events/stream?runId=${encodeURIComponent(runId)}`,
  });
}

async function fetchRunActivityFromRuntime(
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "GET",
    path: `/activity?runId=${encodeURIComponent(runId)}`,
  });
}

function parseRequestedBackend(
  value: string | null,
): RuntimeOrchestratorBackend {
  if (value === "cloudflare_agents") {
    return value;
  }
  return "execution-engine-v1";
}

function jsonResponse(
  req: Request,
  env: Env,
  data: unknown,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getBrainRuntimeHeaders(env),
      ...getCorsHeaders(req, env),
    },
  });
}

function proxyResponse(req: Request, env: Env, response: Response): Response {
  const contentType =
    response.headers.get("Content-Type") ??
    "application/x-ndjson; charset=utf-8";

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": contentType,
      ...getBrainRuntimeHeaders(env),
      ...getCorsHeaders(req, env),
    },
  });
}

function errorResponse(
  req: Request,
  env: Env,
  message: string,
  status: number,
): Response {
  return jsonResponse(req, env, { error: message }, status);
}

async function readErrorPreview(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as { error?: string };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error.trim();
    }
  } catch {
    // No-op: fallback to text preview.
  }

  try {
    const text = (await response.text()).trim();
    if (text.length > 0) {
      return text.slice(0, 200);
    }
  } catch {
    // No-op
  }

  return "";
}
