import {
  canPreloadProvider,
  type BYOKCredential,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import type { ProviderModelOption } from "../services/api/providerClient.js";
import { resolveWebProviderProductPolicy } from "./provider-product-policy";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

interface ProviderModelBootstrapLoadingArgs {
  status: "idle" | "loading" | "ready" | "error";
  catalog: ProviderRegistryEntry[];
  credentials: BYOKCredential[];
  providerModels: Record<string, ProviderModelOption[]>;
  selectedProviderId?: string | null;
}

interface ProviderVisibleModelHydrationArgs {
  selectedProviderId: string | null;
  providerModels: Record<string, ProviderModelOption[]>;
  visibleModelIds: Record<string, Set<string>>;
  manageProviderModels: Record<string, ProviderModelOption[]>;
}

export function isProviderModelBootstrapLoading({
  status,
  catalog,
  credentials,
  providerModels,
  selectedProviderId,
}: ProviderModelBootstrapLoadingArgs): boolean {
  if (status === "loading") {
    return true;
  }

  if (status !== "ready") {
    return false;
  }

  const pendingProviderIds = selectedProviderId
    ? [selectedProviderId]
    : collectBootstrapModelPreloadProviderIds(catalog, credentials);
  if (pendingProviderIds.length === 0) {
    return false;
  }

  return pendingProviderIds.some(
    (providerId) =>
      !Object.prototype.hasOwnProperty.call(providerModels, providerId),
  );
}

export function isProviderVisibleModelHydrationPending({
  selectedProviderId,
  providerModels,
  visibleModelIds,
  manageProviderModels,
}: ProviderVisibleModelHydrationArgs): boolean {
  if (!selectedProviderId) {
    return false;
  }

  const visibleSet = visibleModelIds[selectedProviderId];
  if (!visibleSet || visibleSet.size === 0) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(providerModels, selectedProviderId)) {
    return false;
  }

  const pickerModelIds = new Set(
    (providerModels[selectedProviderId] ?? []).map((model) => model.id),
  );
  const hasMissingVisibleModel = [...visibleSet].some(
    (modelId) => !pickerModelIds.has(modelId),
  );

  if (!hasMissingVisibleModel) {
    return false;
  }

  return !Object.prototype.hasOwnProperty.call(
    manageProviderModels,
    selectedProviderId,
  );
}

function collectBootstrapModelPreloadProviderIds(
  catalog: ProviderRegistryEntry[],
  credentials: BYOKCredential[],
): string[] {
  const providerIds = new Set<string>();
  const catalogProviderIds = new Set(
    catalog.map((entry) => entry.providerId),
  );

  if (
    catalogProviderIds.has("axis") &&
    canPreloadProvider(WEB_PROVIDER_POLICY, "axis")
  ) {
    providerIds.add("axis");
  }

  for (const credential of credentials) {
    if (
      catalogProviderIds.has(credential.providerId) &&
      canPreloadProvider(WEB_PROVIDER_POLICY, credential.providerId)
    ) {
      providerIds.add(credential.providerId);
    }
  }

  return Array.from(providerIds);
}
