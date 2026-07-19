import type { CoreMessage } from "ai";
import {
  TurnScopeBootstrapSchema,
  type TurnScopeBootstrap,
} from "@repo/platform-protocol";
import type { RunMode } from "@repo/shared-types";
import type {
  AgentType,
  RepositoryContext,
} from "@shadowbox/execution-engine/runtime";
import type { Env } from "../types/ai";
import {
  DomainError,
  PolicyError,
  ValidationError,
  isDomainError,
} from "../domain/errors";
import type { SerializableToolDefinition } from "../types/tools";
import { parseOptionalScopeIdentifier } from "./chat-request-helpers";
import { extractSessionToken } from "../services/AuthService";
import { resolveAuthorizedProviderScope } from "./provider/ProviderAuthScopeService";
import { createTraceContext, formatTraceparent } from "@repo/observability";

type RuntimeHarnessId = "cloudflare-sandbox" | "local-sandbox";
type RuntimeOrchestratorBackend = "execution-engine-v1" | "cloudflare_agents";
type RuntimeExecutionBackend = "cloudflare_sandbox" | "e2b" | "daytona";
type RuntimeHarnessMode = "platform_owned" | "delegated";
type RuntimeAuthMode = "api_key" | "oauth";
export type RuntimeExecutionTarget = "do";

export interface ExecutionScope {
  userId: string;
  workspaceId: string;
}

export interface RunEngineExecutionPayload {
  runId: string;
  userId?: string;
  workspaceId?: string;
  sessionId: string;
  correlationId: string;
  requestOrigin?: string;
  input: {
    mode: RunMode;
    agentType: AgentType;
    prompt: string;
    sessionId: string;
    providerId?: string;
    modelId?: string;
    harnessId?: RuntimeHarnessId;
    orchestratorBackend: RuntimeOrchestratorBackend;
    executionBackend: RuntimeExecutionBackend;
    harnessMode: RuntimeHarnessMode;
    authMode: RuntimeAuthMode;
    repositoryContext?: RepositoryContext;
  };
  messages: CoreMessage[];
  tools?: Record<string, SerializableToolDefinition>;
  identity: TurnScopeBootstrap;
}

export function extractPromptFromMessages(
  messages: CoreMessage[],
  correlationId: string,
): string {
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();

  if (!lastUserMessage) {
    throw new ValidationError(
      "No user message found",
      "NO_USER_MESSAGE",
      correlationId,
    );
  }

  const extractedText = extractTextFromMessageContent(lastUserMessage.content);
  if (extractedText.length > 0) {
    return extractedText;
  }

  return safeStringify(lastUserMessage.content);
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => extractTextFromPart(part))
      .filter((part) => part.length > 0);
    return parts.join("\n").trim();
  }

  return extractTextFromPart(content);
}

function extractTextFromPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  const record = part as Record<string, unknown>;

  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  if (typeof record.content === "string") {
    return record.content;
  }

  return "";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function resolveExecutionScope(
  req: Request,
  env: Env,
  runId: string,
  correlationId: string,
): Promise<ExecutionScope> {
  const sessionToken = extractSessionToken(req);
  if (!sessionToken) {
    throw new DomainError(
      "AUTH_FAILED",
      "Unauthorized: missing authentication token.",
      401,
      false,
      correlationId,
    );
  }

  const scopeHeaders = new Headers(req.headers);
  scopeHeaders.set("X-Run-Id", runId);
  const scopedRequest = new Request(req.url, {
    method: req.method,
    headers: scopeHeaders,
  });

  try {
    const scope = await resolveAuthorizedProviderScope(
      scopedRequest,
      env,
      correlationId,
    );
    return {
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    };
  } catch (error) {
    if (isDomainError(error)) {
      throw error;
    }
    throw new DomainError(
      "AUTH_FAILED",
      "Failed to resolve authenticated execution scope.",
      401,
      false,
      correlationId,
    );
  }
}

export async function executeViaRunEngineDurableObject(
  env: Env,
  runId: string,
  payload: RunEngineExecutionPayload,
): Promise<Response> {
  return fetchRunRuntimeRoute(env, runId, payload.input.orchestratorBackend, {
    method: "POST",
    path: "/execute",
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      traceparent: formatTraceparent(createTraceContext()),
    },
  });
}

export async function startRunTurn(
  env: Env,
  runId: string,
  payload: Pick<
    RunEngineExecutionPayload,
    "sessionId" | "workspaceId" | "userId" | "correlationId"
  > & {
    clientMessageId?: string;
  },
  requestedBackend: RuntimeOrchestratorBackend,
): Promise<TurnScopeBootstrap> {
  const response = await fetchRunRuntimeRoute(env, runId, requestedBackend, {
    method: "POST",
    path: "/turn/start",
    body: JSON.stringify({ runId, ...payload }),
    headers: {
      "Content-Type": "application/json",
      traceparent: formatTraceparent(createTraceContext()),
    },
  });
  if (!response.ok) {
    throw new DomainError(
      "TURN_BOOTSTRAP_FAILED",
      "Failed to establish the server-owned turn scope.",
      response.status,
      response.status >= 500,
      payload.correlationId,
    );
  }
  return TurnScopeBootstrapSchema.parse(await response.json());
}

export async function fetchRunRuntimeRoute(
  env: Env,
  runId: string,
  requestedBackend: RuntimeOrchestratorBackend,
  requestInit: {
    method: "GET" | "POST";
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const runtimeTarget = resolveRuntimeTarget(env, requestedBackend);
  return fetchViaRunEngineDurableObject(env, runId, requestInit);
}

export function resolveRuntimeTarget(
  env: Env,
  requestedBackend: RuntimeOrchestratorBackend,
): RuntimeExecutionTarget {
  if (requestedBackend === "cloudflare_agents") {
    throw new PolicyError(
      "cloudflare_agents is quarantined; use the canonical RunEngineRuntime Durable Object.",
      "CLOUDFLARE_AGENTS_BACKEND_DISABLED",
    );
  }

  return "do";
}

async function fetchViaRunEngineDurableObject(
  env: Env,
  runId: string,
  requestInit: {
    method: "GET" | "POST";
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  if (!env.RUN_ENGINE_RUNTIME) {
    throw new Error("RUN_ENGINE_RUNTIME binding is unavailable");
  }

  const id = env.RUN_ENGINE_RUNTIME.idFromName(runId);
  const stub = env.RUN_ENGINE_RUNTIME.get(id);
  const runtimeResponse = await stub.fetch(
    `https://run-engine${requestInit.path}`,
    {
      method: requestInit.method,
      headers: requestInit.headers,
      body: requestInit.body,
    },
  );
  return runtimeResponse as unknown as Response;
}
