import {
  readProviderPreferences,
  updateProviderPreferences,
  resolveProviderPreferences,
} from "../integration/app-server/ProviderPreferenceOperations";
import {
  listProviderCredentials,
  connectProviderCredential,
  updateProviderCredential,
  disconnectProviderCredential,
  validateProviderCredential,
} from "../integration/app-server/ProviderCredentialOperations";
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

import {
  BYOKResolveRequestSchema,
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKPreferencesUpdateRequestSchema,
  type BYOKResolveRequest,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKPreferencesUpdateRequest,
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKDisconnectRequestSchema,
  BYOKDisconnectResponseSchema,
  BYOKPreferencesPatchSchema,
  BYOKPreferencesSchema,
  BYOKValidateRequestSchema,
  BYOKValidateResponseSchema,
  ProviderCatalogResponseSchema,
  ProviderErrorEnvelopeSchema,
  ProviderConnectionsResponseSchema,
  type BYOKDiscoveredProviderModelsQuery,
  BYOKProviderSlugSchema,
} from "@repo/shared-types";
import type { Env } from "../types/ai";
import { jsonResponse, withEngineHeaders } from "../http/response";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import {
  ValidationError,
  isDomainError,
  normalizeProviderErrorCode,
  toNormalizedProviderError,
} from "../domain/errors";
import {
  resolveAuthorizedProviderScope,
  type AuthorizedProviderScope,
} from "./provider/ProviderAuthScopeService";
import {
  proxyProviderOperation,
  proxyByokOperation,
} from "../integration/app-server/ProviderRuntimeProxy";

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
      const preference = await readProviderPreferences(
        req,
        env,
        scope,
        correlationId,
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
      const body = await parseRequestBody(req, correlationId);
      const patch = validateWithSchema<BYOKPreferencesUpdateRequest>(
        body,
        BYOKPreferencesUpdateRequestSchema,
        correlationId,
      );

      const preference = await updateProviderPreferences(
        req,
        env,
        scope,
        correlationId,
        patch,
      );
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
      const body = await parseRequestBody(req, correlationId);
      const request = validateWithSchema<BYOKResolveRequest>(
        body,
        BYOKResolveRequestSchema,
        correlationId,
      );

      const resolution = await resolveProviderPreferences(
        req,
        env,
        scope,
        correlationId,
        request,
      );
      return withScopeJson(req, env, scope, resolution);
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
