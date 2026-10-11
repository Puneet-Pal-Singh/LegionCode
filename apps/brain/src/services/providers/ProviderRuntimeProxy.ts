import { z } from "zod";
import {
  ProviderCatalogResponseSchema,
  ProviderErrorEnvelopeSchema,
  type ProviderCatalogResponse,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { builtinProviderRegistry } from "@repo/provider-core";
import type { Env } from "../../types/ai";
import type { AuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import { withEngineHeaders } from "../../http/response";
import { validateWithSchema } from "../../http/validation";
import {
  ValidationError,
  ProviderError,
  normalizeProviderErrorCode,
} from "../../domain/errors";

const PROVIDER_RUNTIME_TIMEOUT_MS = 15_000;
type ProviderRuntimeStub = ReturnType<Env["RUN_ENGINE_RUNTIME"]["get"]>;

export async function proxyProviderOperation(
  req: Request,
  env: Env,
  operation: {
    scope: AuthorizedProviderScope;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
  },
): Promise<Response> {
  const id = env.RUN_ENGINE_RUNTIME.idFromName(operation.scope.runId);
  const stub = env.RUN_ENGINE_RUNTIME.get(id);
  const headers = new Headers({
    "X-Run-Id": operation.scope.runId,
    "X-User-Id": operation.scope.userId,
    "X-Workspace-Id": operation.scope.workspaceId,
  });

  let body: string | undefined;
  if (operation.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(operation.body);
  }

  const response = await fetchRuntimeProviderResponse(
    stub,
    operation,
    headers,
    body,
  );
  const materialized = await materializeRuntimeResponse(response);

  return withEngineHeaders(req, env, materialized, operation.scope.runId);
}

async function fetchRuntimeProviderResponse(
  stub: ProviderRuntimeStub,
  operation: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
  },
  headers: Headers,
  body: string | undefined,
): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResponse = new Promise<Response>((resolve) => {
    timeout = setTimeout(() => {
      resolve(
        new Response(
          JSON.stringify({
            error: "Provider runtime request timed out.",
            code: "PROVIDER_RUNTIME_TIMEOUT",
            retryable: true,
          }),
          {
            status: 504,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }, PROVIDER_RUNTIME_TIMEOUT_MS);
  });

  try {
    const runtimeResponse = stub.fetch(`https://run-engine${operation.path}`, {
      method: operation.method,
      headers,
      body,
    }) as unknown as Promise<Response>;
    return await Promise.race([runtimeResponse, timeoutResponse]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function materializeRuntimeResponse(
  response: Response,
): Promise<Response> {
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

export async function proxyByokOperation(
  req: Request,
  env: Env,
  operation: {
    scope: AuthorizedProviderScope;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
  },
  responseSchema: z.ZodSchema,
  correlationId: string,
): Promise<Response> {
  const response = await proxyProviderOperation(req, env, operation);
  if (!response.ok) {
    return await normalizeByokRuntimeError(
      req,
      env,
      response,
      operation.scope,
      correlationId,
    );
  }

  await validateProxyResponse(response, responseSchema, correlationId);
  return response;
}

async function validateProxyResponse(
  response: Response,
  schema: z.ZodSchema,
  correlationId: string,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    throw new ValidationError(
      "Provider runtime returned non-JSON response",
      "INVALID_PROVIDER_RESPONSE",
      correlationId,
    );
  }
  validateWithSchema(payload, schema, correlationId);
}

async function normalizeByokRuntimeError(
  req: Request,
  env: Env,
  response: Response,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<Response> {
  const parsed = await parseProviderErrorBody(response);
  const code = normalizeProviderErrorCode(parsed.code, response.status);
  const message = parsed.message || "Provider request failed";
  const retryable =
    parsed.retryable ?? (response.status >= 500 || code === "RATE_LIMITED");
  logByokRuntimeError(correlationId, code, response.status, message);

  const normalized = new Response(
    JSON.stringify(
      ProviderErrorEnvelopeSchema.parse({
        error: {
          code,
          message,
          retryable,
          correlationId,
        },
      }),
    ),
    {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
  return withEngineHeaders(req, env, normalized, scope.runId);
}

async function parseProviderErrorBody(response: Response): Promise<{
  code?: string;
  message?: string;
  retryable?: boolean;
  correlationId?: string;
}> {
  try {
    const payload = await response.clone().json();
    if (!payload || typeof payload !== "object") {
      return {};
    }
    const raw = payload as Record<string, unknown>;
    const envelope = ProviderErrorEnvelopeSchema.safeParse(payload);
    if (envelope.success) {
      return envelope.data.error;
    }
    const nestedError =
      raw.error && typeof raw.error === "object"
        ? (raw.error as Record<string, unknown>)
        : undefined;
    const code =
      typeof raw.code === "string"
        ? raw.code
        : typeof nestedError?.code === "string"
          ? nestedError.code
          : undefined;
    const message =
      typeof raw.error === "string"
        ? raw.error
        : typeof raw.message === "string"
          ? raw.message
          : typeof nestedError?.message === "string"
            ? nestedError.message
            : undefined;
    const retryable =
      typeof raw.retryable === "boolean"
        ? raw.retryable
        : typeof nestedError?.retryable === "boolean"
          ? nestedError.retryable
          : undefined;
    const correlationId =
      typeof raw.correlationId === "string"
        ? raw.correlationId
        : typeof nestedError?.correlationId === "string"
          ? nestedError.correlationId
          : undefined;
    return { code, message, retryable, correlationId };
  } catch {
    return {};
  }
}

function logByokRuntimeError(
  correlationId: string,
  code: string,
  status: number,
  message: string,
): void {
  const formatted = `[provider/byok] ${correlationId}: runtime error ${code} (${status}) - ${message}`;
  if (code === "AUTH_FAILED") {
    console.log(formatted);
    return;
  }
  console.warn(formatted);
}

async function readResponseJson<T>(
  response: Response,
  correlationId: string,
): Promise<T> {
  try {
    return (await response.clone().json()) as T;
  } catch {
    throw new ValidationError(
      "Provider runtime returned invalid JSON payload.",
      "INVALID_PROVIDER_RESPONSE",
      correlationId,
    );
  }
}

export async function readProxyResponseJson<T>(
  response: Response,
  schema: z.ZodSchema,
  correlationId: string,
): Promise<T> {
  if (!response.ok) {
    const errorDetails = await parseProviderErrorBody(response);
    throw new ProviderError(
      errorDetails.message ?? "Provider request failed",
      normalizeProviderErrorCode(errorDetails.code, response.status),
      response.status,
      errorDetails.retryable ?? response.status >= 500,
      errorDetails.correlationId ?? correlationId,
    );
  }

  const payload = await readResponseJson<unknown>(response, correlationId);
  return validateWithSchema<T>(payload, schema, correlationId);
}

export async function fetchRuntimeCatalog(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<ProviderCatalogResponse> {
  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "GET",
      path: "/providers/catalog",
    },
    ProviderCatalogResponseSchema,
    correlationId,
  );
  return await readProxyResponseJson(
    response,
    ProviderCatalogResponseSchema,
    correlationId,
  );
}

export function mapCatalogEntryToRegistry(
  entry: ProviderCatalogResponse["providers"][number],
): ProviderRegistryEntry {
  const builtin = builtinProviderRegistry.getProvider(entry.providerId);
  return {
    providerId: entry.providerId,
    displayName: entry.displayName,
    authModes: builtin?.authModes ?? ["api_key"],
    launchStage: builtin?.launchStage ?? "supported",
    adapterFamily: builtin?.adapterFamily ?? "custom-http",
    capabilities: {
      streaming: entry.capabilities.streaming,
      tools: entry.capabilities.tools,
      jsonMode: entry.capabilities.jsonMode,
      structuredOutputs: entry.capabilities.structuredOutputs,
    },
    modelSource: builtin?.modelSource ?? "static",
    defaultModelId: entry.defaultModelId ?? entry.models[0]?.id,
    ...(builtin?.baseUrl ? { baseUrl: builtin.baseUrl } : {}),
    ...(builtin?.keyFormat ? { keyFormat: builtin.keyFormat } : {}),
  };
}
