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
import {
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import type {
  RunEventRecord,
  RunRecord,
  RunStepRecord,
} from "@repo/persistence";

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
  terminalState?: string | null;
  terminalMessage?: Record<string, unknown> | null;
  permissionContext?: unknown;
  pendingApproval?: unknown;
}

export class RunController {
  static async getSummary(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const runId = url.searchParams.get("runId")?.trim();

      if (!runId) {
        return errorResponse(req, env, "runId is required", 400);
      }

      const auth = await getAuthenticatedUserSession(req, env);
      if (!auth) {
        return errorResponse(req, env, "Unauthorized", 401);
      }

      const summary = await withRunRepository(env, async (repo) => {
        const run = await repo.getRun(runId, auth.userId);
        if (!run) {
          return null;
        }
        const [events, steps] = await Promise.all([
          repo.listRunEvents(runId, auth.userId),
          repo.listRunSteps(runId, auth.userId),
        ]);
        return buildPostgresRunSummary(run, events, steps);
      });

      if (!summary) {
        return errorResponse(req, env, "Run not found", 404);
      }

      return jsonResponse(req, env, summary);
    } catch (error) {
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(req, env, error.message, 503);
      }
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

      const auth = await getAuthenticatedUserSession(req, env);
      if (!auth) {
        return errorResponse(req, env, "Unauthorized", 401);
      }

      const ownsRun = await verifyRunOwnership(env, runId, auth.userId);
      if (!ownsRun) {
        return errorResponse(req, env, "Run not found", 404);
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
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(req, env, error.message, 503);
      }
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
      const auth = await getAuthenticatedUserSession(req, env);
      if (!auth) {
        return errorResponse(req, env, "Unauthorized", 401);
      }

      const payload = await parseApproveRequest(req);
      const ownsRun = await verifyRunOwnership(env, payload.runId, auth.userId);
      if (!ownsRun) {
        return errorResponse(req, env, "Run not found", 404);
      }

      const responsePayload = await resolveApprovalFromRuntime(env, payload);
      return jsonResponse(req, env, responsePayload);
    } catch (error) {
      if (error instanceof ApproveRequestError) {
        return errorResponse(req, env, error.message, error.status);
      }
      if (isStaleApprovalResolutionError(error)) {
        return errorResponse(
          req,
          env,
          "No pending approval request found.",
          409,
        );
      }
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(req, env, error.message, 503);
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

      const auth = await getAuthenticatedUserSession(req, env);
      if (!auth) {
        return errorResponse(req, env, "Unauthorized", 401);
      }

      const result = await withRunRepository(env, async (repo) => {
        const run = await repo.getRun(runId, auth.userId);
        if (!run) {
          return null;
        }
        return await repo.listRunEvents(runId, auth.userId);
      });

      if (!result) {
        return errorResponse(req, env, "Run not found", 404);
      }
      return jsonResponse(req, env, result);
    } catch (error) {
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(req, env, error.message, 503);
      }
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

      const auth = await getAuthenticatedUserSession(req, env);
      if (!auth) {
        return errorResponse(req, env, "Unauthorized", 401);
      }

      const ownsRun = await verifyRunOwnership(env, runId, auth.userId);
      if (!ownsRun) {
        return errorResponse(req, env, "Run not found", 404);
      }

      const response = await fetchRunEventsStreamFromRuntime(
        req,
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

      return response;
    } catch (error) {
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(req, env, error.message, 503);
      }
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

      const auth = await getAuthenticatedUserSession(req, env);
      if (!auth) {
        return errorResponse(req, env, "Unauthorized", 401);
      }

      const ownsRun = await verifyRunOwnership(env, runId, auth.userId);
      if (!ownsRun) {
        return errorResponse(req, env, "Run not found", 404);
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
      if (isSessionStoreUnavailableError(error)) {
        return errorResponse(req, env, error.message, 503);
      }
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

function buildPostgresRunSummary(
  run: RunRecord,
  events: RunEventRecord[],
  steps: RunStepRecord[],
): RunSummaryResponse {
  const terminalState = resolvePostgresTerminalState(run.status, steps);
  return {
    runId: run.id,
    status: run.status,
    totalTasks: steps.length,
    completedTasks: countStepsByStatus(steps, "completed"),
    failedTasks: countStepsByStatus(steps, "failed"),
    runningTasks: countStepsByStatus(steps, "running"),
    pendingTasks: countStepsByStatus(steps, "pending"),
    cancelledTasks: countStepsByStatus(steps, "cancelled"),
    eventCount: events.length,
    lastEventType: events.at(-1)?.eventType ?? null,
    terminalState,
    terminalMessage: terminalState
      ? buildPostgresTerminalMessage(terminalState, steps)
      : null,
  };
}

function countStepsByStatus(
  steps: RunStepRecord[],
  status: RunStepRecord["status"],
): number {
  return steps.filter((step) => step.status === status).length;
}

function resolvePostgresTerminalState(
  status: RunRecord["status"],
  steps: RunStepRecord[],
): string | null {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return countStepsByStatus(steps, "failed") > 0
        ? "failed_tool"
        : "failed_runtime";
    case "cancelled":
      return "cancelled";
    case "paused":
      return "interrupted";
    case "created":
    case "running":
      return null;
  }
}

function buildPostgresTerminalMessage(
  terminalState: string,
  steps: RunStepRecord[],
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    nextAction: resolvePostgresNextAction(terminalState),
  };
  const lastSuccessfulStep = findLatestStepLabel(steps, "completed");
  const failedStep = findLatestStepLabel(steps, "failed");

  if (lastSuccessfulStep) {
    message.lastSuccessfulStep = lastSuccessfulStep;
  }
  if (failedStep) {
    message.failedStep = failedStep;
  }

  return message;
}

function findLatestStepLabel(
  steps: RunStepRecord[],
  status: RunStepRecord["status"],
): string | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.status !== status) {
      continue;
    }
    return readStepLabel(step);
  }
  return null;
}

function readStepLabel(step: RunStepRecord): string {
  return (
    readPayloadString(step.payload, "toolName") ??
    readPayloadString(step.payload, "title") ??
    readPayloadString(step.payload, "name") ??
    step.stepType
  );
}

function readPayloadString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value[key];
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePostgresNextAction(terminalState: string): string {
  switch (terminalState) {
    case "completed":
      return "Review the changed files, then send the next task when ready.";
    case "failed_tool":
    case "failed_runtime":
      return "Inspect the failed step and retry after fixing the blocker.";
    case "interrupted":
      return "Resume or cancel the run from the workflow controls.";
    case "cancelled":
      return "Start a new run when you are ready.";
    default:
      return "Review the run details before continuing.";
  }
}

async function verifyRunOwnership(
  env: Env,
  runId: string,
  userId: string,
): Promise<boolean> {
  return await withRunRepository(env, async (repo) => {
    const run = await repo.getRun(runId, userId);
    return run !== null;
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

async function fetchRunEventsStreamFromRuntime(
  req: Request,
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<Response> {
  const headers = buildRuntimeForwardHeaders(req);
  return fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "GET",
    path: `/events/stream?runId=${encodeURIComponent(runId)}`,
    ...(headers ? { headers } : {}),
  });
}

function buildRuntimeForwardHeaders(
  req: Request,
): Record<string, string> | null {
  const origin = req.headers.get("Origin");
  if (!origin) {
    return null;
  }
  return { Origin: origin };
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
