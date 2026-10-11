import type { BYOKPreferencesUpdateRequest } from "@repo/shared-types";
import { resolveBrainProviderProductPolicy } from "../../lib/provider-product-policy";
import { loadConnectedCredentials } from "./ProviderCredentialOperations";
import { fetchRuntimeCatalog } from "./ProviderRuntimeProxy";
import { z } from "zod";
import {
  AXIS_PROVIDER_ID,
  canUseProviderAtRuntime,
  canUseProviderRuntimeFallback,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKPreferencesSchema,
  ProviderIdSchema,
  type BYOKCredential,
  type BYOKPreference,
  type ProviderProductPolicy,
  type BYOKResolution,
  type BYOKResolveRequest,
  type BYOKDiscoveredProviderModelsResponse,
  type ProviderCatalogResponse,
} from "@repo/shared-types";
import { builtinProviderRegistry } from "@repo/provider-core";
import type { Env } from "../../types/ai";
import type { AuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import {
  NotFoundError,
  ProviderNotConnectedError,
  ValidationError,
} from "../../domain/errors";
import { findDiscoveredChatModelMetadata } from "../../services/chat/ChatModelMetadataResolver";
import {
  proxyByokOperation,
  readProxyResponseJson,
  fetchRuntimePreferences,
  buildRuntimeModelsPath,
} from "./ProviderRuntimeProxy";
import { buildVirtualCredentialId } from "./ProviderCredentialOperations";

const AxisQuotaMetadataSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  resetsAt: z.string().datetime(),
});

export async function resolveSelectedModelMetadata(
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

export async function fetchRuntimeAxisQuota(
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

export async function loadWorkspacePreference(
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
export function resolveSelection(
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

export async function readProviderPreferences(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  const preference = await loadWorkspacePreference(
    req,
    env,
    scope,
    correlationId,
    policy,
  );
  return preference;
}

export async function updateProviderPreferences(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  patch: BYOKPreferencesUpdateRequest,
) {
  const policy = resolveBrainProviderProductPolicy(env);
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
  return preference;
}

export async function resolveProviderPreferences(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  request: BYOKResolveRequest,
) {
  const policy = resolveBrainProviderProductPolicy(env);
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

  return {
    ...resolvedModelMetadata,
    ...(axisQuota ? { quota: axisQuota } : {}),
  };
}
