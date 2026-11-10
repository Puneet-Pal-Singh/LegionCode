import { ProviderModelRouteResolver, resolveProviderRuntimeRoute } from "@repo/provider-core";
import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";

const routes = new ProviderModelRouteResolver();

/** Project discovered models through the existing runtime routing policy. */
export function withLocalProviderModelRoute(model: BYOKDiscoveredProviderModel): BYOKDiscoveredProviderModel {
  if (model.availability !== undefined && model.availability !== "available") return model;
  const override = resolveProviderRuntimeRoute(model.providerId, model.id);
  if (!override && model.runtimeRoute) {
    return model.runtimeRoute.providerId === model.providerId && model.runtimeRoute.transport !== "cloudflare-ai-run"
      ? { ...model, availability: "available" }
      : unavailable(model);
  }
  try {
    const route = routes.resolve({
      providerId: model.providerId,
      modelId: model.id,
      discoveredRoute: override ? {
        providerId: model.providerId,
        modelId: override.runtimeModelId,
        transport: override.providerTransport,
        endpoint: override.providerEndpoint,
      } : undefined,
    });
    return {
      ...model,
      availability: "available",
      runtimeRoute: {
        providerId: model.providerId,
        modelId: route.runtimeModelId,
        transport: route.transport,
        endpoint: route.endpoint,
      },
    };
  } catch {
    return unavailable(model);
  }
}

function unavailable(model: BYOKDiscoveredProviderModel): BYOKDiscoveredProviderModel {
  return { ...model, availability: "unsupported_transport", unavailableReason: "This model's runtime transport is unavailable in Desktop." };
}
