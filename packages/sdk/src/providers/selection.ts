import {
  BYOKCredential as ProviderCredential,
  BYOKPreference as ProviderPreference,
  ProviderRegistryEntry,
} from "@repo/shared-types";

export interface ProviderSelectionSnapshot {
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;
}

export function resolveSelectedModelIdForProvider<TModel extends { id: string }>(
  providerId: string,
  currentModelId: string | null,
  models: TModel[],
  visibleModelIds: Record<string, Set<string>>,
): string | null {
  const visibleSet = visibleModelIds[providerId];
  if (!visibleSet) {
    return currentModelId ?? models[0]?.id ?? null;
  }

  const selectableModels = getSelectableModelsForProvider(
    providerId,
    models,
    visibleModelIds,
  );
  if (currentModelId && visibleSet.has(currentModelId)) {
    return currentModelId;
  }
  if (selectableModels.length === 0) {
    return resolvePendingVisibleModelId(
      currentModelId,
      visibleModelIds[providerId],
    );
  }
  if (!currentModelId) {
    return selectableModels[0]?.id ?? null;
  }
  return selectableModels.some((model) => model.id === currentModelId)
    ? currentModelId
    : (selectableModels[0]?.id ?? null);
}

export function deriveSelectionSnapshot<TModel extends { id: string }>(input: {
  catalog: ProviderRegistryEntry[];
  credentials: ProviderCredential[];
  preferences: ProviderPreference | null;
  providerModels: Record<string, TModel[]>;
  visibleModelIds: Record<string, Set<string>>;
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;
  hasExplicitSessionSelection: boolean;
}): ProviderSelectionSnapshot {
  const {
    catalog,
    credentials,
    preferences,
    providerModels,
    visibleModelIds,
    selectedProviderId,
    selectedCredentialId,
    selectedModelId,
    hasExplicitSessionSelection,
  } = input;

  if (
    hasExplicitSessionSelection &&
    selectedProviderId !== null &&
    selectedCredentialId !== null
  ) {
    return {
      selectedProviderId,
      selectedCredentialId,
      selectedModelId,
    };
  }
  const catalogProviderIds = new Set(
    catalog.map((entry) => entry.providerId),
  );
  const isSelectableProvider = (providerId: string): boolean =>
    catalogProviderIds.has(providerId);
  const selectedCredential = selectedCredentialId
    ? credentials.find(
        (credential) =>
          credential.credentialId === selectedCredentialId &&
          isSelectableProvider(credential.providerId),
      )
    : undefined;
  const hasSelectedProviderCredential = selectedProviderId
    ? credentials.some(
        (credential) =>
          credential.providerId === selectedProviderId &&
          isSelectableProvider(credential.providerId),
      )
    : false;

  const providerId =
    selectedCredential?.providerId ??
    (hasSelectedProviderCredential ? selectedProviderId : null) ??
    (preferences?.defaultProviderId &&
    isSelectableProvider(preferences.defaultProviderId) &&
    credentials.some(
      (credential) =>
        credential.providerId === preferences.defaultProviderId &&
        isSelectableProvider(credential.providerId),
    )
      ? preferences.defaultProviderId
      : null) ??
    credentials.find((credential) =>
      isSelectableProvider(credential.providerId),
    )?.providerId ??
    null;

  const providerCredentials = providerId
    ? credentials.filter(
        (credential) =>
          credential.providerId === providerId &&
          isSelectableProvider(credential.providerId),
      )
    : [];
  const credentialId =
    providerCredentials.find(
      (credential) => credential.credentialId === selectedCredentialId,
    )?.credentialId ??
    (preferences?.defaultCredentialId &&
    providerCredentials.some(
      (credential) =>
        credential.credentialId === preferences.defaultCredentialId,
    )
      ? preferences.defaultCredentialId
      : null) ??
    providerCredentials[0]?.credentialId ??
    null;

  const preferredModelForProvider =
    providerId && selectedProviderId === providerId ? selectedModelId : null;
  const preferredModelId =
    preferredModelForProvider ??
    (preferences?.defaultProviderId === providerId
      ? preferences.defaultModelId
      : undefined) ??
    (providerId
      ? catalog.find((entry) => entry.providerId === providerId)?.defaultModelId
      : undefined) ??
    null;
  const modelId =
    providerId === null
      ? null
      : resolveConstrainedModelId({
          providerId,
          preferredModelId,
          providerModels,
          visibleModelIds,
        });

  return {
    selectedProviderId: providerId,
    selectedCredentialId: credentialId,
    selectedModelId: modelId,
  };
}

export function resolveConstrainedModelId<TModel extends { id: string }>(input: {
  providerId: string;
  preferredModelId: string | null;
  providerModels: Record<string, TModel[]>;
  visibleModelIds: Record<string, Set<string>>;
}): string | null {
  const { providerId, preferredModelId, providerModels, visibleModelIds } =
    input;
  const selectableModels = getSelectableModelsForProvider(
    providerId,
    providerModels[providerId] ?? [],
    visibleModelIds,
  );
  const visibleSet = visibleModelIds[providerId];

  if (!visibleSet) {
    return preferredModelId ?? selectableModels[0]?.id ?? null;
  }

  if (preferredModelId) {
    if (visibleSet.has(preferredModelId)) {
      return preferredModelId;
    }
    if (selectableModels.length > 0) {
      return selectableModels[0]?.id ?? null;
    }
    return resolvePendingVisibleModelId(null, visibleSet);
  }

  if (selectableModels.length > 0) {
    return selectableModels[0]?.id ?? null;
  }

  return resolvePendingVisibleModelId(null, visibleSet);
}

export function resolveModelForResolvedProvider<TModel extends { id: string }>(
  providerId: string,
  resolvedModelId: string,
  providerModels: Record<string, TModel[]>,
  visibleModelIds: Record<string, Set<string>>,
): string | null {
  const visibleSet = visibleModelIds[providerId];
  if (!visibleSet) {
    return resolvedModelId || providerModels[providerId]?.[0]?.id || null;
  }

  if (visibleSet.has(resolvedModelId)) {
    return resolvedModelId;
  }

  const selectableModels = getSelectableModelsForProvider(
    providerId,
    providerModels[providerId] ?? [],
    visibleModelIds,
  );
  if (selectableModels.length > 0) {
    return selectableModels[0]?.id ?? null;
  }

  return resolvePendingVisibleModelId(resolvedModelId, visibleSet);
}

export function resolvePendingVisibleModelId(
  preferredModelId: string | null,
  visibleSet: Set<string> | undefined,
): string | null {
  if (!visibleSet) {
    return preferredModelId;
  }
  if (visibleSet.size === 0) {
    return null;
  }
  if (preferredModelId && visibleSet.has(preferredModelId)) {
    return preferredModelId;
  }
  return visibleSet.values().next().value ?? null;
}

export function getSelectableModelsForProvider<TModel extends { id: string }>(
  providerId: string,
  models: TModel[],
  visibleModelIds: Record<string, Set<string>>,
): TModel[] {
  const visibleSet = visibleModelIds[providerId];
  if (!visibleSet) {
    return models;
  }
  return models.filter((model) => visibleSet.has(model.id));
}
