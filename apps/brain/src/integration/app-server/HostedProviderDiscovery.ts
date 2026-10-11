import { createHostedProviderOperation } from "./HostedProviderScope";
import type {
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsResponse,
  BYOKDiscoveredProviderModelsRefreshResponse,
} from "@repo/shared-types";
import type { AuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import {
  BYOKProviderSlugSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  canShowProviderInPrimaryUi,
} from "@repo/shared-types";
import { type AppServerComposition } from "@legioncode/app-server/server";
import { validateWithSchema } from "../../http/validation";
import { resolveBrainProviderProductPolicy } from "../../lib/provider-product-policy";
import {
  buildRuntimeModelsPath,
  fetchRuntimeCatalog,
  mapCatalogEntryToRegistry,
  proxyByokOperation,
  readProxyResponseJson,
} from "./ProviderRuntimeProxy";
import type { Env } from "../../types/ai";

/** Cookie-bound hosted discovery; runtime catalog/cache and product policy remain the owners. */
export function composeHostedProviderDiscovery(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedProviderDiscoveryService"]> {
  const operation = createHostedProviderOperation(request, env, userId);
  return {
    catalog: (runId) =>
      operation(runId, (scope, correlationId) =>
        readProviderCatalog(request, env, scope, correlationId),
      ),
    models: (runId, providerId, query) =>
      operation(runId, (scope, correlationId) =>
        readProviderModels(
          request,
          env,
          scope,
          providerId,
          BYOKDiscoveredProviderModelsQuerySchema.parse(query ?? {}),
          correlationId,
        ),
      ),
    refresh: (runId, providerId) =>
      operation(runId, (scope, correlationId) =>
        refreshProviderModels(request, env, scope, providerId, correlationId),
      ),
  };
}

export async function readProviderCatalog(
  request: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  const catalog = await fetchRuntimeCatalog(request, env, scope, correlationId);
  return {
    providers: catalog.providers
      .map(mapCatalogEntryToRegistry)
      .filter((provider) =>
        canShowProviderInPrimaryUi(policy, provider.providerId),
      ),
  };
}

export async function readProviderModels(
  request: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  providerId: string,
  query: BYOKDiscoveredProviderModelsQuery,
  correlationId: string,
) {
  const id = validateWithSchema<string>(
    providerId,
    BYOKProviderSlugSchema,
    correlationId,
  );
  const response = await proxyByokOperation(
    request,
    env,
    { scope, method: "GET", path: buildRuntimeModelsPath(id, query) },
    BYOKDiscoveredProviderModelsResponseSchema,
    correlationId,
  );
  return readProxyResponseJson<BYOKDiscoveredProviderModelsResponse>(
    response,
    BYOKDiscoveredProviderModelsResponseSchema,
    correlationId,
  );
}

export async function refreshProviderModels(
  request: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  providerId: string,
  correlationId: string,
) {
  const response = await proxyByokOperation(
    request,
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
  return readProxyResponseJson<BYOKDiscoveredProviderModelsRefreshResponse>(
    response,
    BYOKDiscoveredProviderModelsRefreshResponseSchema,
    correlationId,
  );
}
