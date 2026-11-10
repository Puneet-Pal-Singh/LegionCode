import { MemoryProviderModelCacheStore } from "@repo/persistence";
import { builtinProviderRegistry } from "@repo/provider-core";
import {
  HttpModelDevCatalogSource,
  ProviderCatalogService,
  ProviderModelDiscoveryService,
  type ProviderModelCredentialPort,
} from "@repo/provider-core/discovery";
import type { LocalProviderModelCatalog } from "./local-provider-model-catalog.js";

/** Process-local composition of the same discovery owner used by hosted Web. */
export function createLocalProviderModelDiscovery(
  credentials: ProviderModelCredentialPort,
): LocalProviderModelCatalog {
  const discovery = new ProviderModelDiscoveryService(
    new MemoryProviderModelCacheStore(),
    credentials,
    builtinProviderRegistry,
    undefined,
    undefined,
    undefined,
    new HttpModelDevCatalogSource(),
  );
  return new ProviderCatalogService(
    builtinProviderRegistry,
    discovery,
    async (provider) => provider.launchStage === "supported" && provider.authModes.includes("api_key"),
  );
}
