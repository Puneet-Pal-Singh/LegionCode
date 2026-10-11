import {
  listProviderCredentials,
  connectProviderCredential,
  updateProviderCredential,
  disconnectProviderCredential,
  validateProviderCredential,
} from "../integration/app-server/ProviderCredentialOperations";
import {
  loadConnectedCredentials,
  buildVirtualCredentialId,
} from "../integration/app-server/ProviderCredentialOperations";
import {
  fetchRuntimeConnections,
  fetchRuntimePreferences,
} from "../integration/app-server/ProviderRuntimeProxy";
import {
  readProviderCatalog,
  readProviderModels,
  refreshProviderModels,
} from "../integration/app-server/HostedProviderDiscovery";
/**
 * ProviderController
 * Single Responsibility: Route handlers for provider API endpoints
 * Validates requests and delegates to RunEngineRuntime provider routes
 * to guarantee a single provider-state owner path.
 */

import { z } from "zod";
import {
  AXIS_PROVIDER_ID,
  canUseProviderAtRuntime,
  canUseProviderRuntimeFallback,
  type BYOKCredential,
  type BYOKPreference,
  type ProviderProductPolicy,
  BYOKResolveRequestSchema,
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKPreferencesUpdateRequestSchema,
  type BYOKResolution,
  type BYOKResolveRequest,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKDiscoveredProviderModelsResponse,
  type BYOKPreferencesUpdateRequest,
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKDisconnectRequestSchema,
  BYOKDisconnectResponseSchema,
  BYOKPreferencesPatchSchema,
  type BYOKPreferences,
  BYOKPreferencesSchema,
  BYOKValidateRequestSchema,
  BYOKValidateResponseSchema,
  ProviderCatalogResponseSchema,
  type ProviderCatalogResponse,
  ProviderErrorEnvelopeSchema,
  type BYOKDiscoveredProviderModelsQuery,
  BYOKProviderSlugSchema,
  ProviderIdSchema,
} from "@repo/shared-types";
import { builtinProviderRegistry } from "@repo/provider-core";
import type { Env } from "../types/ai";
import { jsonResponse, withEngineHeaders } from "../http/response";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import {
  NotFoundError,
  ProviderNotConnectedError,
  ValidationError,
  isDomainError,
  normalizeProviderErrorCode,
  toNormalizedProviderError,
} from "../domain/errors";
import {
  resolveAuthorizedProviderScope,
  type AuthorizedProviderScope,
} from "./provider/ProviderAuthScopeService";
import { resolveBrainProviderProductPolicy } from "../lib/provider-product-policy";
import {
  proxyProviderOperation,
  proxyByokOperation,
  readProxyResponseJson,
  fetchRuntimeCatalog,
  buildRuntimeModelsPath,
} from "../integration/app-server/ProviderRuntimeProxy";
import { findDiscoveredChatModelMetadata } from "../services/chat/ChatModelMetadataResolver";

const AxisQuotaMetadataSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  resetsAt: z.string().datetime(),
});

/**
 * ProviderController - Route handlers for provider API
 * Each method handles one specific endpoint responsibility
 * Provider state is delegated to RunEngineRuntime per runId
 */
export class ProviderController {
  static async byokProviderModels(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const providerId = extractProviderIdFromModelsPath(
        req.url,
        correlationId,
      );
      const discoveryQuery = validateDiscoveryQuery(
        buildDiscoveryQueryParams(req.url),
        correlationId,
      );
      const payload = await readProviderModels(
        req,
        env,
        scope,
        providerId,
        discoveryQuery,
        correlationId,
      );
      return withScopeJson(req, env, scope, payload);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokRefreshProviderModels(
    req: Request,
    env: Env,
  ): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const providerId = extractProviderIdFromModelsRefreshPath(
        req.url,
        correlationId,
      );
      const payload = await refreshProviderModels(
        req,
        env,
        scope,
        providerId,
        correlationId,
      );
      return withScopeJson(req, env, scope, payload);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokProviders(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const { providers } = await readProviderCatalog(
        req,
        env,
        scope,
        correlationId,
      );
      return withScopeJson(req, env, scope, providers);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokCredentials(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const credentials = await listProviderCredentials(
        req,
        env,
        scope,
        correlationId,
      );
      return withScopeJson(req, env, scope, credentials);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokConnectCredential(
    req: Request,
    env: Env,
  ): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const request = validateWithSchema<BYOKCredentialConnectRequest>(
        body,
        BYOKCredentialConnectRequestSchema,
        correlationId,
      );

      const credential = await connectProviderCredential(
        req,
        env,
        scope,
        correlationId,
        request,
      );
      return withScopeJson(req, env, scope, credential);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokUpdateCredential(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const credentialId = extractCredentialIdFromPath(
        req.url,
        false,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const patch = validateWithSchema<BYOKCredentialUpdateRequest>(
        body,
        BYOKCredentialUpdateRequestSchema,
        correlationId,
      );

      const credential = await updateProviderCredential(
        req,
        env,
        scope,
        correlationId,
        credentialId,
        patch,
      );
      return withScopeJson(req, env, scope, credential);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokDisconnectCredential(
    req: Request,
    env: Env,
  ): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const credentialId = extractCredentialIdFromPath(
        req.url,
        false,
        correlationId,
      );
      await disconnectProviderCredential(
        req,
        env,
        scope,
        correlationId,
        credentialId,
      );
      return withEngineHeaders(
        req,
        env,
        new Response(null, { status: 204 }),
        scope.runId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokValidateCredential(
    req: Request,
    env: Env,
  ): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const credentialId = extractCredentialIdFromPath(
        req.url,
        true,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const request = validateWithSchema<BYOKCredentialValidateRequest>(
        body,
        BYOKCredentialValidateRequestSchema,
        correlationId,
      );
      const result = await validateProviderCredential(
        req,
        env,
        scope,
        correlationId,
        credentialId,
        request,
      );
      return withScopeJson(req, env, scope, result);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokGetPreferencesV3(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const policy = resolveBrainProviderProductPolicy(env);
      const preference = await loadWorkspacePreference(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      return withScopeJson(req, env, scope, preference);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokPreferencesV3(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const policy = resolveBrainProviderProductPolicy(env);
      const body = await parseRequestBody(req, correlationId);
      const patch = validateWithSchema<BYOKPreferencesUpdateRequest>(
        body,
        BYOKPreferencesUpdateRequestSchema,
        correlationId,
      );

      if (
        patch.defaultProviderId &&
        !canUseProviderAtRuntime(policy, patch.defaultProviderId)
      ) {
        throw new ValidationError(
          `Provider "${patch.defaultProviderId}" is not available in this environment.`,
          "INVALID_PROVIDER_SELECTION",
          correlationId,
        );
      }

      const runtimePatch: Record<string, string> = {};
      if (patch.defaultProviderId) {
        runtimePatch.defaultProviderId = patch.defaultProviderId;
      }
      if (patch.defaultModelId) {
        runtimePatch.defaultModelId = patch.defaultModelId;
      }

      // Add visibleModelIds to patch if provided
      const runtimePatchWithVisibility: typeof runtimePatch & {
        visibleModelIds?: Record<string, string[]>;
      } = { ...runtimePatch };
      if (patch.visibleModelIds) {
        runtimePatchWithVisibility.visibleModelIds = patch.visibleModelIds;
      }

      let runtimePreference: {
        defaultProviderId?: string;
        defaultModelId?: string;
        visibleModelIds?: Record<string, string[]>;
        updatedAt: string;
      };
      if (Object.keys(runtimePatchWithVisibility).length === 0) {
        runtimePreference = await fetchRuntimePreferences(
          req,
          env,
          scope,
          correlationId,
        );
      } else {
        const runtimeResponse = await proxyByokOperation(
          req,
          env,
          {
            scope,
            method: "PATCH",
            path: "/providers/preferences",
            body: runtimePatchWithVisibility,
          },
          BYOKPreferencesSchema,
          correlationId,
        );
        runtimePreference = await readProxyResponseJson(
          runtimeResponse,
          BYOKPreferencesSchema,
          correlationId,
        );
      }

      const preference: BYOKPreference = {
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        defaultProviderId: runtimePreference.defaultProviderId,
        defaultCredentialId: runtimePreference.defaultProviderId
          ? buildVirtualCredentialId(runtimePreference.defaultProviderId)
          : undefined,
        defaultModelId: runtimePreference.defaultModelId,
        visibleModelIds: runtimePreference.visibleModelIds ?? {},
        updatedAt: runtimePreference.updatedAt,
      };
      return withScopeJson(req, env, scope, preference);
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokResolve(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const policy = resolveBrainProviderProductPolicy(env);
      const body = await parseRequestBody(req, correlationId);
      const request = validateWithSchema<BYOKResolveRequest>(
        body,
        BYOKResolveRequestSchema,
        correlationId,
      );

      const credentials = await loadConnectedCredentials(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      const preference = await loadWorkspacePreference(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      const catalog = await fetchRuntimeCatalog(req, env, scope, correlationId);

      const resolution = resolveSelection(
        request,
        credentials,
        preference,
        catalog,
        correlationId,
        policy,
      );
      const resolvedModelMetadata = await resolveSelectedModelMetadata(
        req,
        env,
        scope,
        correlationId,
        resolution,
      );

      const axisQuota =
        resolvedModelMetadata.providerId === AXIS_PROVIDER_ID
          ? await fetchRuntimeAxisQuota(req, env, scope, correlationId)
          : undefined;

      return withScopeJson(req, env, scope, {
        ...resolvedModelMetadata,
        ...(axisQuota ? { quota: axisQuota } : {}),
      });
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  // Legacy v2 handlers retained for transitional compatibility and tests.
  static async byokCatalog(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(`[provider/byok-catalog] ${correlationId} request received`);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      return await proxyByokOperation(
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
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokConnections(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(
      `[provider/byok-connections] ${correlationId} request received`,
    );
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      return await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "GET",
          path: "/providers/connections",
        },
              correlationId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokConnect(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(`[provider/byok-connect] ${correlationId} request received`);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const validatedRequest = validateWithSchema(
        body,
        BYOKConnectRequestSchema,
        correlationId,
      );
      return await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/connect",
          body: validatedRequest,
        },
        BYOKConnectResponseSchema,
        correlationId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokValidate(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(`[provider/byok-validate] ${correlationId} request received`);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const validatedRequest = validateWithSchema(
        body,
        BYOKValidateRequestSchema,
        correlationId,
      );
      return await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/validate",
          body: validatedRequest,
        },
        BYOKValidateResponseSchema,
        correlationId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokDisconnect(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(`[provider/byok-disconnect] ${correlationId} request received`);
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const validatedRequest = validateWithSchema(
        body,
        BYOKDisconnectRequestSchema,
        correlationId,
      );
      return await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/disconnect",
          body: validatedRequest,
        },
        BYOKDisconnectResponseSchema,
        correlationId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokPreferences(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(
      `[provider/byok-preferences] ${correlationId} request received`,
    );
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      const body = await parseRequestBody(req, correlationId);
      const validatedPatch = validateWithSchema(
        body,
        BYOKPreferencesPatchSchema,
        correlationId,
      );
      return await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "PATCH",
          path: "/providers/preferences",
          body: validatedPatch,
        },
        BYOKPreferencesSchema,
        correlationId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }

  static async byokGetPreferences(req: Request, env: Env): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    console.log(
      `[provider/byok-preferences] ${correlationId} request received`,
    );
    try {
      const scope = await resolveAuthorizedProviderScope(
        req,
        env,
        correlationId,
      );
      return await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "GET",
          path: "/providers/preferences",
        },
        BYOKPreferencesSchema,
        correlationId,
      );
    } catch (error) {
      return handleByokError(req, env, error, correlationId);
    }
  }
}

function extractProviderIdFromModelsPath(
  urlValue: string,
  correlationId: string,
): string {
  const url = new URL(urlValue);
  const match = url.pathname.match(/^\/api\/byok\/providers\/([^/]+)\/models$/);
  const providerId = match?.[1];
  if (!providerId) {
    throw new ValidationError(
      "Missing providerId in models request path.",
      "MISSING_PROVIDER_ID",
      correlationId,
    );
  }
  return parseProviderSlug(
    decodeProviderSlug(providerId, correlationId),
    correlationId,
  );
}

function buildDiscoveryQueryParams(urlValue: string): {
  view?: string;
  surface?: string;
  limit?: string;
  cursor?: string;
} {
  const url = new URL(urlValue);
  return {
    view: url.searchParams.get("view") ?? undefined,
    surface: url.searchParams.get("surface") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  };
}

function validateDiscoveryQuery(
  query: {
    view?: string;
    surface?: string;
    limit?: string;
    cursor?: string;
  },
  correlationId: string,
): BYOKDiscoveredProviderModelsQuery {
  const parsed = BYOKDiscoveredProviderModelsQuerySchema.safeParse(query);
  if (parsed.success) {
    return parsed.data;
  }
  throw new ValidationError(
    "Invalid provider model discovery query.",
    "VALIDATION_ERROR",
    correlationId,
  );
}

function extractProviderIdFromModelsRefreshPath(
  urlValue: string,
  correlationId: string,
): string {
  const url = new URL(urlValue);
  const match = url.pathname.match(
    /^\/api\/byok\/providers\/([^/]+)\/models\/refresh$/,
  );
  const providerId = match?.[1];
  if (!providerId) {
    throw new ValidationError(
      "Missing providerId in models refresh request path.",
      "MISSING_PROVIDER_ID",
      correlationId,
    );
  }
  return parseProviderSlug(
    decodeProviderSlug(providerId, correlationId),
    correlationId,
  );
}

function parseProviderSlug(providerId: string, correlationId: string): string {
  const parsed = BYOKProviderSlugSchema.safeParse(providerId);
  if (parsed.success) {
    return parsed.data;
  }
  throw new ValidationError(
    "Invalid providerId in request path.",
    "VALIDATION_ERROR",
    correlationId,
  );
}

function decodeProviderSlug(providerId: string, correlationId: string): string {
  try {
    return decodeURIComponent(providerId);
  } catch {
    throw new ValidationError(
      "Invalid providerId in request path.",
      "VALIDATION_ERROR",
      correlationId,
    );
  }
}

function handleByokError(
  req: Request,
  env: Env,
  error: unknown,
  correlationId: string,
): Response {
  if (isDomainError(error)) {
    logByokDomainError(correlationId, error.code, error.message);
    return buildByokErrorResponse(req, env, {
      status: error.status,
      ...toNormalizedProviderError(error, correlationId),
    });
  }
  console.error(`[provider/byok] ${correlationId}: unexpected error`, error);
  return buildByokErrorResponse(req, env, {
    status: 500,
    ...toNormalizedProviderError(error, correlationId),
  });
}

function logByokDomainError(
  correlationId: string,
  code: string,
  message: string,
): void {
  const formatted = `[provider/byok] ${correlationId}: ${code} - ${message}`;
  if (code === "AUTH_FAILED") {
    console.log(formatted);
    return;
  }
  console.warn(formatted);
}

function buildByokErrorResponse(
  req: Request,
  env: Env,
  input: {
    status: number;
    code?: string;
    message: string;
    retryable?: boolean;
    correlationId?: string;
  },
): Response {
  const code = normalizeProviderErrorCode(input.code, input.status);
  const retryable =
    input.retryable || input.status >= 500 || code === "RATE_LIMITED";
  const envelope = ProviderErrorEnvelopeSchema.parse({
    error: {
      code,
      message: input.message,
      retryable,
      correlationId: input.correlationId,
    },
  });
  return jsonResponse(req, env, envelope, { status: input.status });
}

function withScopeJson(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  payload: unknown,
  status: number = 200,
): Response {
  const response = jsonResponse(req, env, payload, { status });
  return withEngineHeaders(req, env, response, scope.runId);
}

async function resolveSelectedModelMetadata(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  resolution: BYOKResolution,
): Promise<BYOKResolution> {
  if (
    resolution.providerId === AXIS_PROVIDER_ID ||
    (resolution.contextWindow !== undefined && resolution.pricing !== undefined)
  ) {
    return resolution;
  }

  try {
    const providerId = ProviderIdSchema.parse(resolution.providerId);
    const metadata = await findDiscoveredChatModelMetadata(
      {
        getDiscoveredModels: (_providerId, query) =>
          proxyDiscoveredModels(
            req,
            env,
            scope,
            correlationId,
            providerId,
            query,
          ),
      },
      providerId,
      resolution.modelId,
    );
    return { ...resolution, ...metadata };
  } catch (error) {
    console.warn("[provider/resolve] selected model metadata unavailable", {
      providerId: resolution.providerId,
      modelId: resolution.modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return resolution;
  }
}

async function proxyDiscoveredModels(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  providerId: string,
  query: {
    view: "all";
    surface: "picker";
    limit: number;
    cursor?: string;
  },
): Promise<BYOKDiscoveredProviderModelsResponse> {
  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "GET",
      path: buildRuntimeModelsPath(providerId, query),
    },
    BYOKDiscoveredProviderModelsResponseSchema,
    correlationId,
  );
  return readProxyResponseJson(
    response,
    BYOKDiscoveredProviderModelsResponseSchema,
    correlationId,
  );
}

async function fetchRuntimeAxisQuota(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<z.infer<typeof AxisQuotaMetadataSchema>> {
  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "GET",
      path: `/providers/${AXIS_PROVIDER_ID}/quota`,
    },
    AxisQuotaMetadataSchema,
    correlationId,
  );
  return await readProxyResponseJson(
    response,
    AxisQuotaMetadataSchema,
    correlationId,
  );
}

async function loadWorkspacePreference(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  policy: ProviderProductPolicy,
): Promise<BYOKPreference> {
  const runtime = await fetchRuntimePreferences(req, env, scope, correlationId);
  const canUseDefaultProvider =
    runtime.defaultProviderId === undefined ||
    canUseProviderAtRuntime(policy, runtime.defaultProviderId);
  const defaultProviderId = canUseDefaultProvider
    ? runtime.defaultProviderId
    : undefined;

  return {
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    defaultProviderId,
    defaultCredentialId: defaultProviderId
      ? buildVirtualCredentialId(defaultProviderId)
      : undefined,
    defaultModelId: defaultProviderId ? runtime.defaultModelId : undefined,
    visibleModelIds: runtime.visibleModelIds ?? {},
    updatedAt: runtime.updatedAt,
  };
}

/**
 * Resolve provider/model for chat execution.
 *
 * Resolution chain:
 * 1. Request override (providerId/credentialId/modelId)
 * 2. Workspace preference (defaultProviderId/defaultModelId)
 * 3. Platform-managed Axis default when policy allows runtime fallback
 * 4. Strict resolution: throw when no explicit/default provider is resolved
 */
function resolveSelection(
  request: BYOKResolveRequest,
  credentials: BYOKCredential[],
  preference: BYOKPreference,
  catalog: ProviderCatalogResponse,
  correlationId: string,
  policy: ProviderProductPolicy,
): BYOKResolution {
  const selection = resolveCredentialSelection(
    request,
    credentials,
    preference,
    correlationId,
    policy,
  );
  const { selectedCredential } = selection;
  const resolvedAt = selection.resolvedAt;

  if (!selectedCredential) {
    const axisCredentialError = resolveAxisPlatformCredentialErrorMessage(
      request,
      preference,
      credentials,
      policy,
    );
    if (axisCredentialError) {
      throw new ValidationError(
        axisCredentialError,
        "AUTH_FAILED",
        correlationId,
      );
    }
    throw new ProviderNotConnectedError(
      request.providerId ?? preference.defaultProviderId ?? "provider",
      correlationId,
    );
  }

  const modelId = resolveModelForSelectedProvider(
    request,
    preference,
    selectedCredential.providerId,
    catalog,
    correlationId,
  );
  const contextWindow =
    catalog.providers
      .find((provider) => provider.providerId === selectedCredential.providerId)
      ?.models.find((model) => model.id === modelId)?.contextWindow ??
    builtinProviderRegistry.getModel(selectedCredential.providerId, modelId)
      ?.contextWindow;

  return {
    providerId: selectedCredential.providerId,
    credentialId: selectedCredential.credentialId,
    modelId,
    ...(contextWindow ? { contextWindow } : {}),
    resolvedAt,
    resolvedAtTime: new Date().toISOString(),
  };
}

function resolveCredentialForProvider(
  credentials: BYOKCredential[],
  providerId?: string,
): BYOKCredential | undefined {
  if (!providerId) {
    return undefined;
  }
  return credentials.find((credential) => credential.providerId === providerId);
}

function resolveCredentialSelection(
  request: BYOKResolveRequest,
  credentials: BYOKCredential[],
  preference: BYOKPreference,
  correlationId: string,
  policy: ProviderProductPolicy,
): {
  selectedCredential: BYOKCredential | undefined;
  resolvedAt: BYOKResolution["resolvedAt"];
} {
  const credentialFromRequest = resolveCredentialFromRequest(
    request,
    credentials,
    correlationId,
  );

  if (credentialFromRequest) {
    return {
      selectedCredential: credentialFromRequest,
      resolvedAt: "request_override",
    };
  }

  if (request.providerId) {
    if (!canUseProviderAtRuntime(policy, request.providerId)) {
      throw new ValidationError(
        `Provider "${request.providerId}" is not available in this environment.`,
        "INVALID_PROVIDER_SELECTION",
        correlationId,
      );
    }
    const credential = resolveCredentialForProvider(
      credentials,
      request.providerId,
    );
    if (!credential) {
      throw new ProviderNotConnectedError(request.providerId, correlationId);
    }
    return {
      selectedCredential: credential,
      resolvedAt: "session_preference",
    };
  }

  if (preference.defaultProviderId) {
    if (!canUseProviderAtRuntime(policy, preference.defaultProviderId)) {
      return {
        selectedCredential: undefined,
        resolvedAt: "workspace_preference",
      };
    }
    const credential = resolveCredentialForProvider(
      credentials,
      preference.defaultProviderId,
    );
    if (credential) {
      return {
        selectedCredential: credential,
        resolvedAt: request.modelId
          ? "session_preference"
          : "workspace_preference",
      };
    }
  }

  const axisCredential = canUseProviderRuntimeFallback(policy, AXIS_PROVIDER_ID)
    ? resolveCredentialForProvider(credentials, AXIS_PROVIDER_ID)
    : undefined;
  if (axisCredential) {
    return {
      selectedCredential: axisCredential,
      resolvedAt: "platform_defaults",
    };
  }

  return {
    selectedCredential: undefined,
    resolvedAt: "workspace_preference",
  };
}

function resolveAxisPlatformCredentialErrorMessage(
  request: BYOKResolveRequest,
  preference: BYOKPreference,
  credentials: BYOKCredential[],
  policy: ProviderProductPolicy,
): string | null {
  if (!canUseProviderRuntimeFallback(policy, AXIS_PROVIDER_ID)) {
    return null;
  }

  const hasAxisCredential = credentials.some(
    (credential) => credential.providerId === AXIS_PROVIDER_ID,
  );
  if (hasAxisCredential) {
    return null;
  }

  const preferredProviderId =
    request.providerId ?? preference.defaultProviderId;
  const canResolveToAxisByDefault = preferredProviderId === undefined;
  const usesAxisPath =
    preferredProviderId === AXIS_PROVIDER_ID || canResolveToAxisByDefault;
  if (!usesAxisPath) {
    return null;
  }

  return "Missing AXIS_OPENROUTER_API_KEY for platform-managed Axis provider. Connect a BYOK API-key provider in Provider Settings to continue.";
}

function resolveCredentialFromRequest(
  request: BYOKResolveRequest,
  credentials: BYOKCredential[],
  correlationId: string,
): BYOKCredential | undefined {
  if (!request.credentialId) {
    return undefined;
  }

  const credential = credentials.find(
    (entry) => entry.credentialId === request.credentialId,
  );
  if (!credential) {
    throw new NotFoundError(
      `Credential "${request.credentialId}" was not found.`,
      "CREDENTIAL_NOT_FOUND",
      correlationId,
    );
  }

  if (request.providerId && credential.providerId !== request.providerId) {
    throw new ValidationError(
      "providerId does not match credentialId scope.",
      "INVALID_PROVIDER_SELECTION",
      correlationId,
    );
  }

  return credential;
}

function resolveModelForSelectedProvider(
  request: BYOKResolveRequest,
  preference: BYOKPreference,
  selectedProviderId: string,
  catalog: ProviderCatalogResponse,
  correlationId: string,
): string {
  if (request.modelId) {
    return request.modelId;
  }
  if (
    preference.defaultProviderId === selectedProviderId &&
    preference.defaultModelId
  ) {
    return preference.defaultModelId;
  }
  return resolveDefaultModel(selectedProviderId, catalog, correlationId);
}

function resolveDefaultModel(
  providerId: string,
  catalog: ProviderCatalogResponse,
  correlationId: string,
): string {
  const provider = catalog.providers.find(
    (entry) => entry.providerId === providerId,
  );
  const modelId = provider?.defaultModelId ?? provider?.models[0]?.id;
  if (modelId) {
    return modelId;
  }
  throw new ValidationError(
    `Provider "${providerId}" has no discoverable models available for selection.`,
    "MODEL_NOT_ALLOWED",
    correlationId,
  );
}

function extractCredentialIdFromPath(
  urlValue: string,
  hasValidateSuffix: boolean,
  correlationId: string,
): string {
  const pathname = new URL(urlValue).pathname;
  const pattern = hasValidateSuffix
    ? /^\/api\/byok\/credentials\/([^/]+)\/validate$/
    : /^\/api\/byok\/credentials\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match?.[1]) {
    throw new ValidationError(
      "Invalid credential path.",
      "INVALID_CREDENTIAL_PATH",
      correlationId,
    );
  }
  return decodeURIComponent(match[1]);
}
