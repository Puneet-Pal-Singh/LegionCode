import {
  AppServerOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import type {
  CompactTurnRequest,
  CompactTurnResponse,
  GetTurnDiffRequest,
  GetTurnDiffResponse,
  LifecycleEvent,
  ReplayLifecycleEventsRequest,
  ReplayLifecycleEventsResponse,
  SubmitLifecycleApprovalRequest,
} from "@repo/platform-protocol";
import {
  CompactTurnResponseSchema,
  GetTurnDiffResponseSchema,
  LifecycleEventSchema,
  ProtocolErrorSchema,
  ReplayLifecycleEventsResponseSchema,
  runIdFromTurnId,
} from "@repo/platform-protocol";
import { fetchRunRuntimeRoute } from "../../controllers/chat-runtime-helpers";
import { isSessionStoreUnavailableError } from "../../services/AuthService";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import type { Env } from "../../types/ai";
import { z } from "zod";

type HostedLifecycleService = NonNullable<AppServerComposition["hostedLifecycleOperationsService"]>;

/** Existing lifecycle reads and commands composed with the App Server's verified cookie principal. */
export function composeHostedLifecycleOperations(
  request: Request,
  env: Env,
  userId: string,
): HostedLifecycleService {
  return {
    replayLifecycleEvents: (params) => replay(request, env, userId, params),
    getTurnDiff: (params) => getDiff(request, env, userId, params),
    submitLifecycleApproval: (params) => submitApproval(request, env, userId, params),
    compactTurn: (params) => compact(request, env, userId, params),
  };
}

async function replay(
  request: Request,
  env: Env,
  userId: string,
  params: ReplayLifecycleEventsRequest,
): Promise<ReplayLifecycleEventsResponse> {
  const runId = runIdFromTurnId(params.turnId);
  try {
    const ownsRun = await verifyRunOwnership(env, runId, userId);
    const reservedAdmission = !ownsRun && await withTurnAdmissionRepository(env, async (repository) => {
      const admission = await repository.getByTurnId(params.turnId);
      if (!admission || admission.userId !== userId || admission.runId !== runId) return false;
      if (admission.state === "reserved") return true;
      return verifyRunOwnership(env, runId, userId);
    });
    if (!ownsRun && !reservedAdmission) throw notFound("Run not found");

    const query = new URLSearchParams({ turnId: params.turnId });
    if (params.afterSequence != null) query.set("afterSequence", String(params.afterSequence));
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    const response = await fetchRunRuntimeRoute(env, runId, params.backend ?? "execution-engine-v1", {
      method: "GET",
      path: `/lifecycle-events?${query.toString()}`,
      signal: request.signal,
    });
    return await readRuntimeResponse(response, ReplayLifecycleEventsResponseSchema);
  } catch (error) {
    throw mapLifecycleFailure(error);
  }
}

async function getDiff(
  request: Request,
  env: Env,
  userId: string,
  params: GetTurnDiffRequest,
): Promise<GetTurnDiffResponse> {
  const runId = runIdFromTurnId(params.turnId);
  try {
    if (!(await verifyRunOwnership(env, runId, userId))) throw notFound("Run not found");
    const query = new URLSearchParams({ turnId: params.turnId });
    const response = await fetchRunRuntimeRoute(env, runId, params.backend ?? "execution-engine-v1", {
      method: "GET",
      path: `/turn-diff?${query.toString()}`,
      signal: request.signal,
    });
    return await readRuntimeResponse(response, GetTurnDiffResponseSchema);
  } catch (error) {
    throw mapLifecycleFailure(error);
  }
}

async function submitApproval(
  request: Request,
  env: Env,
  userId: string,
  params: SubmitLifecycleApprovalRequest,
): Promise<LifecycleEvent> {
  const runId = runIdFromTurnId(params.turnId);
  try {
    if (!(await verifyRunOwnership(env, runId, userId))) throw notFound("Run not found");
    if (params.grantScope && params.decision !== "approved") {
      throw new AppServerOperationError(400, "invalid_request", "Approval grant scope requires an approved decision", "API_ERROR", false);
    }
    const query = new URLSearchParams({ turnId: params.turnId, approvalId: params.approvalId });
    const { backend, ...approvalPayload } = params;
    const response = await fetchRunRuntimeRoute(env, runId, backend ?? "execution-engine-v1", {
      method: "POST",
      path: `/lifecycle-approval?${query.toString()}`,
      body: JSON.stringify(approvalPayload),
      headers: { "Content-Type": "application/json" },
      signal: request.signal,
    });
    return await readRuntimeResponse(response, LifecycleEventSchema);
  } catch (error) {
    throw mapLifecycleFailure(error);
  }
}

async function compact(
  request: Request,
  env: Env,
  userId: string,
  params: CompactTurnRequest,
): Promise<CompactTurnResponse> {
  const runId = runIdFromTurnId(params.turnId);
  try {
    if (!(await verifyRunOwnership(env, runId, userId))) throw notFound("Run not found");
    const { backend, ...compactRequest } = params;
    const response = await fetchRunRuntimeRoute(env, runId, backend ?? "execution-engine-v1", {
      method: "POST",
      path: "/compact",
      body: JSON.stringify(compactRequest),
      headers: { "Content-Type": "application/json" },
      signal: request.signal,
    });
    return await readRuntimeResponse(response, CompactTurnResponseSchema);
  } catch (error) {
    throw mapLifecycleFailure(error);
  }
}

async function verifyRunOwnership(env: Env, runId: string, userId: string): Promise<boolean> {
  return withRunRepository(env, async (repository) => Boolean(await repository.getRun(runId, userId)));
}

async function readRuntimeResponse<Schema extends z.ZodTypeAny>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  const isJson = response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
  if (!isJson) {
    const preview = response.ok ? "" : await readErrorPreview(response);
    throw new AppServerOperationError(
      response.ok ? 502 : response.status,
      response.ok ? "server_unavailable" : statusCategory(response.status),
      response.ok ? "Expected JSON response" : `Unexpected non-JSON error response${preview}`,
      response.ok ? "INVALID_RESPONSE_FORMAT" : "INVALID_ERROR_RESPONSE",
      false,
    );
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new AppServerOperationError(
      response.ok ? 502 : response.status,
      response.ok ? "server_unavailable" : statusCategory(response.status),
      response.ok ? "Expected JSON response" : `Malformed JSON error response${formatErrorPreview(text)}`,
      response.ok ? "INVALID_RESPONSE_FORMAT" : "INVALID_ERROR_RESPONSE",
      false,
    );
  }

  if (!response.ok) throw runtimeError(response.status, payload);
  try {
    return schema.parse(payload);
  } catch {
    throw new AppServerOperationError(502, "server_unavailable", "Invalid lifecycle response", "INVALID_RESPONSE_CONTRACT", false);
  }
}

async function readErrorPreview(response: Response): Promise<string> {
  try {
    return formatErrorPreview(await response.text());
  } catch {
    return "";
  }
}

function formatErrorPreview(body: string): string {
  const preview = body.trim().slice(0, 120);
  return preview ? `: ${preview}` : "";
}

function runtimeError(status: number, payload: unknown): AppServerOperationError {
  const protocolError = ProtocolErrorSchema.safeParse(payload);
  if (protocolError.success) {
    const error = protocolError.data;
    return new AppServerOperationError(status, statusCategory(status), error.message, error.code, error.retryable, error.correlationId ?? undefined);
  }
  const nested = payload && typeof payload === "object" ? (payload as Record<string, unknown>).error : undefined;
  const nestedProtocolError = ProtocolErrorSchema.safeParse(nested);
  if (nestedProtocolError.success) {
    const error = nestedProtocolError.data;
    return new AppServerOperationError(status, statusCategory(status), error.message, error.code, error.retryable, error.correlationId ?? undefined);
  }

  const fields = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nestedFields = fields.error && typeof fields.error === "object" ? fields.error as Record<string, unknown> : {};
  const code = typeof fields.code === "string" ? fields.code : typeof nestedFields.code === "string" ? nestedFields.code : "API_ERROR";
  const message = typeof fields.message === "string" ? fields.message : typeof nestedFields.message === "string" ? nestedFields.message : `HTTP ${status}`;
  const correlationId = typeof fields.correlationId === "string" ? fields.correlationId : typeof nestedFields.correlationId === "string" ? nestedFields.correlationId : undefined;
  return new AppServerOperationError(
    status,
    statusCategory(status),
    message,
    code,
    status >= 500 || status === 429,
    correlationId,
  );
}

function mapLifecycleFailure(error: unknown): AppServerOperationError {
  if (error instanceof AppServerOperationError) return error;
  if (isSessionStoreUnavailableError(error)) {
    return new AppServerOperationError(503, "server_unavailable", `HTTP 503`, "API_ERROR", true);
  }
  return new AppServerOperationError(500, "server_unavailable", "HTTP 500", "API_ERROR", true);
}

function statusCategory(status: number): "unauthorized" | "forbidden" | "not_found" | "conflict" | "invalid_request" | "server_unavailable" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500 || status === 408 || status === 429) return "server_unavailable";
  return "invalid_request";
}

function notFound(message: string): AppServerOperationError {
  return new AppServerOperationError(404, "not_found", message, "API_ERROR", false);
}
