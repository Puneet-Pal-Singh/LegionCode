import type { ProviderModelOption } from "../services/api/providerClient.js";

interface ProviderModelBootstrapLoadingArgs {
  status: "idle" | "loading" | "ready" | "error";
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
  providerModels,
  selectedProviderId,
}: ProviderModelBootstrapLoadingArgs): boolean {
  if (status === "loading") {
    return true;
  }

  if (status !== "ready") {
    return false;
  }

  if (!selectedProviderId) {
    return false;
  }

  return !Object.prototype.hasOwnProperty.call(
    providerModels,
    selectedProviderId,
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

  if (
    !Object.prototype.hasOwnProperty.call(providerModels, selectedProviderId)
  ) {
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
