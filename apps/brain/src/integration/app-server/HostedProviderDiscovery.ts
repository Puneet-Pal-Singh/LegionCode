import { RunIdSchema } from "@repo/platform-protocol";
import {
  BYOKProviderSlugSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  canShowProviderInPrimaryUi,
} from "@repo/shared-types";
import {
  AppServerProviderOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import { resolveAuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import {
  DomainError,
  isDomainError,
  toNormalizedProviderError,
} from "../../domain/errors";
import { validateWithSchema } from "../../http/validation";
import { resolveBrainProviderProductPolicy } from "../../lib/provider-product-policy";
import {
  buildRuntimeModelsPath,
  fetchRuntimeCatalog,
  mapCatalogEntryToRegistry,
  proxyByokOperation,
  readProxyResponseJson,
} from "../../services/providers/ProviderRuntimeProxy";
import type { Env } from "../../types/ai";

/** Cookie-bound hosted discovery; runtime catalog/cache and product policy remain the owners. */
export function composeHostedProviderDiscovery(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedProviderDiscoveryService"]> {
  const operation = async <T>(
    runId: string,
    action: (
      scope: Awaited<ReturnType<typeof resolveAuthorizedProviderScope>>,
      correlationId: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const correlationId = Math.random().toString(36).substring(7);
    try {
      const scope = await resolveAuthorizedProviderScope(
        request,
        env,
        correlationId,
        RunIdSchema.parse(runId),
      );
      if (scope.userId !== userId)
        throw new DomainError(
          "AUTH_FAILED",
          "Unauthorized",
          401,
          false,
          correlationId,
        );
      return await action(scope, correlationId);
    } catch (error) {
      throw new AppServerProviderOperationError(
        isDomainError(error) ? error.status : 500,
        toNormalizedProviderError(error, correlationId),
      );
    }
  };
  return {
    catalog: (runId) =>
      operation(runId, async (scope, correlationId) => {
        const policy = resolveBrainProviderProductPolicy(env);
        const catalog = await fetchRuntimeCatalog(
          request,
          env,
          scope,
          correlationId,
        );
        return {
          providers: catalog.providers
            .map(mapCatalogEntryToRegistry)
            .filter((provider) =>
              canShowProviderInPrimaryUi(policy, provider.providerId),
            ),
        };
      }),
    models: (runId, providerId, query) =>
      operation(runId, async (scope, correlationId) => {
        const id = validateWithSchema<string>(
          providerId,
          BYOKProviderSlugSchema,
          correlationId,
        );
        const discoveryQuery = BYOKDiscoveredProviderModelsQuerySchema.parse(
          query ?? {},
        );
        const response = await proxyByokOperation(
          request,
          env,
          {
            scope,
            method: "GET",
            path: buildRuntimeModelsPath(id, discoveryQuery),
          },
          BYOKDiscoveredProviderModelsResponseSchema,
          correlationId,
        );
        return readProxyResponseJson(
          response,
          BYOKDiscoveredProviderModelsResponseSchema,
          correlationId,
        );
      }),
    refresh: (runId, providerId) =>
      operation(runId, async (scope, correlationId) => {
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
        return readProxyResponseJson(
          response,
          BYOKDiscoveredProviderModelsRefreshResponseSchema,
          correlationId,
        );
      }),
  };
}
