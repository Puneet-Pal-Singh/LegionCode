/**
 * ProviderController
 * Single Responsibility: Route handlers for provider API endpoints
 * Validates requests and delegates to RunEngineRuntime provider routes
 * to guarantee a single provider-state owner path.
 */

import { z } from "zod";
import {
  AXIS_PROVIDER_ID,
  canShowProviderInPrimaryUi,
  canUseProviderAtRuntime,
  canUseProviderRuntimeFallback,
  findBuiltinProvider,
  type ProviderRegistryEntry,
  type BYOKCredential,
  type BYOKPreference,
  type ProviderProductPolicy,
  BYOKResolveRequestSchema,
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKProviderModelsResponseSchema,
  BYOKPreferencesUpdateRequestSchema,
  type BYOKResolution,
  type BYOKResolveRequest,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKDiscoveredProviderModelsResponse,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKProviderModelsResponse,
  type BYOKPreferencesUpdateRequest,
  type BYOKValidateResponse,
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
  type ProviderConnection,
  ProviderConnectionsResponseSchema,
  ProviderErrorEnvelopeSchema,
  type ProviderConnectionsResponse,
  type BYOKDiscoveredProviderModelsQuery,
  BYOKProviderSlugSchema,
} from "@repo/shared-types";
import type { Env } from "../types/ai";
import { jsonResponse, withEngineHeaders } from "../http/response";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import {
  NotFoundError,
  ProviderError,
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

const WorkspaceByokMetadataSchema = z.object({
  credentialLabels: z.record(z.string(), z.string()).default({}),
});
const AxisQuotaMetadataSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  resetsAt: z.string().datetime(),
});
type WorkspaceByokMetadata = z.infer<typeof WorkspaceByokMetadataSchema>;

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
      const discoveryQuery = buildDiscoveryQueryParams(req.url);
      const hasDiscoveryParams = hasDiscoveryQuery(discoveryQuery);
      const runtimePath = buildRuntimeModelsPath(
        providerId,
        hasDiscoveryParams
          ? validateDiscoveryQuery(discoveryQuery, correlationId)
          : discoveryQuery,
      );

      if (hasDiscoveryParams) {
        const response = await proxyByokOperation(
          req,
          env,
          {
            scope,
            method: "GET",
            path: runtimePath,
          },
          BYOKDiscoveredProviderModelsResponseSchema,
          correlationId,
        );
        const payload = await readProxyResponseJson(
          response,
          BYOKDiscoveredProviderModelsResponseSchema,
          correlationId,
        );
        return withScopeJson(req, env, scope, payload);
      }

      const response = await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "GET",
          path: runtimePath,
        },
        BYOKProviderModelsResponseSchema,
        correlationId,
      );
      const payload = await readProxyResponseJson<BYOKProviderModelsResponse>(
        response,
        BYOKProviderModelsResponseSchema,
        correlationId,
      );
      return withScopeJson(
        req,
        env,
        scope,
        payload.models.map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
        })),
      );
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
      const response = await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/models/refresh",
          body: { providerId },
        },
        BYOKDiscoveredProviderModelsRefreshResponseSchema,
        correlationId,
      );
      const payload = await readProxyResponseJson(
        response,
        BYOKDiscoveredProviderModelsRefreshResponseSchema,
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
      const policy = resolveBrainProviderProductPolicy(env);
      const catalog = await fetchRuntimeCatalog(req, env, scope, correlationId);
      const providers = catalog.providers
        .map((provider) => mapCatalogEntryToRegistry(provider))
        .filter((provider) =>
          canShowProviderInPrimaryUi(policy, provider.providerId),
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
      const policy = resolveBrainProviderProductPolicy(env);
      const credentials = await loadConnectedCredentials(
        req,
        env,
        scope,
        correlationId,
        policy,
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
      const policy = resolveBrainProviderProductPolicy(env);
      const body = await parseRequestBody(req, correlationId);
      const request = validateWithSchema<BYOKCredentialConnectRequest>(
        body,
        BYOKCredentialConnectRequestSchema,
        correlationId,
      );

      if (!canUseProviderAtRuntime(policy, request.providerId)) {
        throw new ValidationError(
          `Provider "${request.providerId}" is not available in this environment.`,
          "INVALID_PROVIDER_SELECTION",
          correlationId,
        );
      }

      await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/connect",
          body: {
            providerId: request.providerId,
            apiKey: request.secret,
          },
        },
        BYOKConnectResponseSchema,
        correlationId,
      );

      await ensureDefaultPreferenceConfigured(
        req,
        env,
        scope,
        request.providerId,
        correlationId,
      );

      const credentialId = buildVirtualCredentialId(request.providerId);
      if (request.label) {
        await persistCredentialLabel(
          req,
          env,
          scope,
          credentialId,
          request.label,
          correlationId,
        );
      }

      const credentials = await loadConnectedCredentials(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      const credential = credentials.find(
        (entry) => entry.providerId === request.providerId,
      );
      if (!credential) {
        throw new ValidationError(
          `Provider "${request.providerId}" did not return a connected credential.`,
          "PROVIDER_NOT_CONNECTED",
          correlationId,
        );
      }
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
      const policy = resolveBrainProviderProductPolicy(env);
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

      if (patch.label) {
        await persistCredentialLabel(
          req,
          env,
          scope,
          credentialId,
          patch.label,
          correlationId,
        );
      }

      const credentials = await loadConnectedCredentials(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      const credential = credentials.find(
        (entry) => entry.credentialId === credentialId,
      );
      if (!credential) {
        throw new NotFoundError(
          `Credential "${credentialId}" was not found.`,
          "CREDENTIAL_NOT_FOUND",
          correlationId,
        );
      }
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
      const policy = resolveBrainProviderProductPolicy(env);
      const credentialId = extractCredentialIdFromPath(
        req.url,
        false,
        correlationId,
      );
      const credentials = await loadConnectedCredentials(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      const credential = credentials.find(
        (entry) => entry.credentialId === credentialId,
      );
      if (!credential) {
        throw new NotFoundError(
          `Credential "${credentialId}" was not found.`,
          "CREDENTIAL_NOT_FOUND",
          correlationId,
        );
      }

      await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/disconnect",
          body: { providerId: credential.providerId },
        },
        BYOKDisconnectResponseSchema,
        correlationId,
      );
      await deleteCredentialLabel(req, env, scope, credentialId, correlationId);

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
      const policy = resolveBrainProviderProductPolicy(env);
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
      const credentials = await loadConnectedCredentials(
        req,
        env,
        scope,
        correlationId,
        policy,
      );
      const credential = credentials.find(
        (entry) => entry.credentialId === credentialId,
      );
      if (!credential) {
        throw new NotFoundError(
          `Credential "${credentialId}" was not found.`,
          "CREDENTIAL_NOT_FOUND",
          correlationId,
        );
      }

      const runtimeResponse = await proxyByokOperation(
        req,
        env,
        {
          scope,
          method: "POST",
          path: "/providers/validate",
          body: { providerId: credential.providerId, mode: request.mode },
        },
        BYOKValidateResponseSchema,
        correlationId,
      );
      const validated = await readProxyResponseJson<BYOKValidateResponse>(
        runtimeResponse,
        BYOKValidateResponseSchema,
        correlationId,
      );

      return withScopeJson(req, env, scope, {
        credentialId,
        valid: validated.status === "valid",
        validatedAt: validated.checkedAt,
      });
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

      const axisQuota =
        resolution.providerId === AXIS_PROVIDER_ID
          ? await fetchRuntimeAxisQuota(req, env, scope, correlationId)
          : undefined;

      return withScopeJson(req, env, scope, {
        ...resolution,
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
        ProviderConnectionsResponseSchema,
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

function hasDiscoveryQuery(query: {
  view?: string;
  surface?: string;
  limit?: string;
  cursor?: string;
}): boolean {
  return (
    query.view !== undefined ||
    query.surface !== undefined ||
    query.limit !== undefined ||
    query.cursor !== undefined
  );
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

function buildRuntimeModelsPath(
  providerId: string,
  query: {
    view?: string;
    surface?: string;
    limit?: string | number;
    cursor?: string;
  },
): string {
  const params = new URLSearchParams({
    providerId,
  });
  if (query.view) {
    params.set("view", query.view);
  }
  if (query.surface) {
    params.set("surface", query.surface);
  }
  if (query.limit) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }
  return `/providers/models?${params.toString()}`;
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

async function proxyProviderOperation(
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

  const response = await stub.fetch(`https://run-engine${operation.path}`, {
    method: operation.method,
    headers,
    body,
  });

  return withEngineHeaders(
    req,
    env,
    response as unknown as Response,
    operation.scope.runId,
  );
}

async function proxyByokOperation(
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

async function readProxyResponseJson<T>(
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

async function fetchRuntimeCatalog(
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

async function fetchRuntimeConnections(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<ProviderConnectionsResponse> {
  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "GET",
      path: "/providers/connections",
    },
    ProviderConnectionsResponseSchema,
    correlationId,
  );
  return await readProxyResponseJson(
    response,
    ProviderConnectionsResponseSchema,
    correlationId,
  );
}

async function fetchRuntimePreferences(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<BYOKPreferences> {
  const response = await proxyByokOperation(
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
  return await readProxyResponseJson(
    response,
    BYOKPreferencesSchema,
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

function mapCatalogEntryToRegistry(
  entry: ProviderCatalogResponse["providers"][number],
): ProviderRegistryEntry {
  const builtin = findBuiltinProvider(entry.providerId);
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
    defaultModelId: entry.models[0]?.id ?? builtin?.defaultModelId,
    ...(builtin?.baseUrl ? { baseUrl: builtin.baseUrl } : {}),
    ...(builtin?.keyFormat ? { keyFormat: builtin.keyFormat } : {}),
  };
}

async function loadConnectedCredentials(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  policy: ProviderProductPolicy,
): Promise<BYOKCredential[]> {
  const runtime = await fetchRuntimeConnections(req, env, scope, correlationId);
  const metadata = await loadWorkspaceByokMetadata(
    req,
    env,
    scope,
    correlationId,
  );
  const now = new Date().toISOString();
  const credentials: BYOKCredential[] = [];

  for (const connection of runtime.connections) {
    if (connection.status !== "connected") {
      continue;
    }
    if (!canUseProviderAtRuntime(policy, connection.providerId)) {
      continue;
    }

    const credentialId = buildVirtualCredentialId(connection.providerId);
    credentials.push({
      credentialId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      providerId: connection.providerId,
      label: resolveCredentialLabel(connection, credentialId, metadata),
      keyFingerprint: connection.keyFingerprint ?? "unavailable",
      encryptedSecretJson: "{}",
      keyVersion: "v2",
      status: connection.status,
      lastValidatedAt: connection.lastValidatedAt ?? null,
      lastErrorCode: connection.errorCode,
      lastErrorMessage: connection.errorMessage,
      createdAt: connection.lastValidatedAt ?? now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  return credentials;
}

function resolveCredentialLabel(
  connection: ProviderConnection,
  credentialId: string,
  metadata: WorkspaceByokMetadata,
): string {
  if (connection.providerId === AXIS_PROVIDER_ID) {
    return metadata.credentialLabels[credentialId] ?? "Axis (Free)";
  }
  return (
    metadata.credentialLabels[credentialId] ?? `${connection.providerId} key`
  );
}

function buildVirtualCredentialId(providerId: string): string {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < providerId.length; index += 1) {
    const code = providerId.charCodeAt(index);
    const position = index % 16;
    const current = bytes[position] ?? 0;
    bytes[position] = (current + code + index) & 0xff;
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
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

  return {
    providerId: selectedCredential.providerId,
    credentialId: selectedCredential.credentialId,
    modelId,
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
  const modelId = provider?.models[0]?.id;
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

async function ensureDefaultPreferenceConfigured(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  providerId: string,
  correlationId: string,
): Promise<void> {
  const existingPreference = await fetchRuntimePreferences(
    req,
    env,
    scope,
    correlationId,
  );
  if (existingPreference.defaultProviderId) {
    return;
  }

  const catalog = await fetchRuntimeCatalog(req, env, scope, correlationId);
  const defaultModel = resolveDefaultModel(providerId, catalog, correlationId);
  await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "PATCH",
      path: "/providers/preferences",
      body: {
        defaultProviderId: providerId,
        defaultModelId: defaultModel,
      },
    },
    BYOKPreferencesSchema,
    correlationId,
  );
}

async function persistCredentialLabel(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  credentialId: string,
  label: string,
  correlationId: string,
): Promise<void> {
  await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "POST",
      path: "/providers/preferences/credential-labels",
      body: {
        credentialId,
        label,
      },
    },
    BYOKPreferencesSchema,
    correlationId,
  );
}

async function deleteCredentialLabel(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  credentialId: string,
  correlationId: string,
): Promise<void> {
  await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "DELETE",
      path: `/providers/preferences/credential-labels/${encodeURIComponent(credentialId)}`,
    },
    BYOKPreferencesSchema,
    correlationId,
  );
}

async function loadWorkspaceByokMetadata(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<WorkspaceByokMetadata> {
  const preferences = await fetchRuntimePreferences(
    req,
    env,
    scope,
    correlationId,
  );
  return {
    credentialLabels: preferences.credentialLabels ?? {},
  };
}
