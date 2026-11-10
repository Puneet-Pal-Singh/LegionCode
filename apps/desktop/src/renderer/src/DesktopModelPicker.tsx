import {
  ModelPickerPopover,
  type ModelPickerModel,
} from "@legioncode/client-ui";
import type { LocalWorkspaceGrant, WorkspaceId } from "@repo/platform-protocol";
import {
  PROVIDER_MODEL_CACHE_MAX_AGE_MS,
  assertProviderModelDiscoveryAvailable,
  ProviderClientOperationError,
  loadCompletePickerInventory,
  loadManageProviderModelInventory,
  shouldLoadCompletePickerInventory,
  includeManagedPickerModels,
  type AppServerClient,
} from "@legioncode/sdk";
import {
  createProviderProductPolicy,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type DesktopModelPickerClient = Pick<
  AppServerClient,
  | "getWorkspaceGrant"
  | "readProviderPreferences"
  | "getProviderCatalog"
  | "getProviderModels"
  | "refreshProviderModels"
  | "getProviderSelection"
  | "selectProvider"
>;
type Selection = Awaited<ReturnType<AppServerClient["getProviderSelection"]>>;
type Scope = {
  client: DesktopModelPickerClient | null;
  revision: number;
  workspaceId: WorkspaceId | null;
  grantedAt: string | null;
  enabled: boolean;
  modelReadGenerations: Map<string, number>;
};
type PreferenceScope = Pick<LocalWorkspaceGrant, "workspaceId" | "grantedAt">;
type PickerRead = {
  scope: Scope;
  catalog: ProviderRegistryEntry[];
  credentials: Array<{ providerId: string }>;
  models: Record<string, ModelPickerModel[]>;
  pages: Record<string, Awaited<ReturnType<AppServerClient["getProviderModels"]>>>;
  providerErrors: Record<string, string>;
  selection: Selection;
  visibleModelIds: Record<string, Set<string>>;
  error: string | null;
};

// The local provider service exposes supported API-key routes, without Axis fallback.
const DESKTOP_PROVIDER_POLICY = createProviderProductPolicy("production");

async function loadDesktopPickerInventory(
  client: DesktopModelPickerClient,
  providerId: string,
  visibleIds: ReadonlySet<string>,
  selectedModelId: string | undefined,
  assertCurrent: () => void,
) {
  const loadPage = async (query: Parameters<AppServerClient["getProviderModels"]>[2]) => {
    assertCurrent();
    const page = await client.getProviderModels(providerId, undefined, query);
    assertCurrent();
    assertProviderModelDiscoveryAvailable(page);
    return page;
  };
  const complete = shouldLoadCompletePickerInventory({
    providerId, view: "all", surface: "picker", append: false,
  });
  const page = complete
    ? await loadCompletePickerInventory({ providerId, loadPage })
    : await loadPage({ view: "popular", surface: "picker", limit: 50 });
  const missingMetadata = [...visibleIds, ...(selectedModelId ? [selectedModelId] : [])]
    .some((id) => !page.models.some((model) => model.id === id));
  const managed = missingMetadata
    ? await loadManageProviderModelInventory({ providerId, loadPage }) : null;
  return { ...page, models: includeManagedPickerModels(page.models, managed?.models ?? [], visibleIds, selectedModelId) };
}

/** Local SDK routing plus protected credential-status metadata; no provider secrets or hosted state. */
export function useDesktopModelPicker(
  client: DesktopModelPickerClient | null,
  revision: number,
  workspace: PreferenceScope | null,
  enabled = true,
) {
  const scope = useMemo(
    () => ({
      client,
      revision,
      workspaceId: workspace?.workspaceId ?? null,
      grantedAt: workspace?.grantedAt ?? null,
      enabled,
      modelReadGenerations: new Map<string, number>(),
    }),
    [client, revision, workspace?.workspaceId, workspace?.grantedAt, enabled],
  );
  const activeScope = useRef<Scope | null>(scope);
  const [read, setRead] = useState<PickerRead | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);

  useEffect(() => {
    let active = true;
    setRead(null);
    setSelectionError(null);
    setSaving(false);
    const currentClient = scope.client;
    if (!currentClient || !scope.enabled) return;
    const preferences = scope.workspaceId && scope.grantedAt
      ? currentClient.getWorkspaceGrant().then((grant) => {
          if (
            !grant ||
            grant.readiness !== "ready" ||
            grant.workspaceId !== scope.workspaceId ||
            grant.grantedAt !== scope.grantedAt
          ) throw new Error("Workspace scope changed");
          if (!active || activeScope.current !== scope)
            throw new Error("Provider scope changed");
          return currentClient.readProviderPreferences(undefined, {
            workspaceId: grant.workspaceId,
            grantedAt: grant.grantedAt,
          });
        })
      : Promise.resolve(null);
    void Promise.all([
      currentClient.getProviderCatalog(),
      currentClient.getProviderSelection(),
      window.desktop.credential({ operation: "list" }),
      preferences,
    ])
      .then(async ([catalog, selection, statuses, preferences]) => {
        if (!Array.isArray(statuses))
          throw new Error("Credential status metadata is unavailable");
        if (!active || activeScope.current !== scope) return;
        const credentials = statuses
          .filter(
            (status) =>
              status.status === "present" &&
              catalog.some(
                (provider) => provider.providerId === status.providerId,
              ),
          )
          .map(({ providerId }) => ({ providerId }));
        const assertReadCurrent = () => {
          if (!active || activeScope.current !== scope) throw new Error("Provider scope changed");
        };
        const inventories = await Promise.allSettled(
          credentials.map(async ({ providerId }) => {
            const visibleIds = new Set(preferences?.visibleModelIds[providerId] ?? []);
            const selectedModelId = selection?.providerId === providerId ? selection.modelId : undefined;
            const page = await loadDesktopPickerInventory(currentClient, providerId, visibleIds, selectedModelId, assertReadCurrent);
            return [providerId, page] as const;
          }),
        );
        if (active && activeScope.current === scope) {
          const pages = inventories.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          const providerErrors: Record<string, string> = {};
          inventories.forEach((result, index) => {
            const credential = credentials[index];
            if (result.status === "rejected" && credential) {
              providerErrors[credential.providerId] = result.reason instanceof ProviderClientOperationError
                ? result.reason.message
                : "Provider models could not be loaded. Retry discovery or open provider setup.";
            }
          });
          setRead({
            scope,
            catalog,
            credentials,
            models: Object.fromEntries(pages.map(([id, page]) => [id, page.models])),
            pages: Object.fromEntries(pages),
            providerErrors,
            selection,
            visibleModelIds: Object.fromEntries(
              Object.entries(preferences?.visibleModelIds ?? {}).map(
                ([providerId, ids]) => [providerId, new Set(ids)],
              ),
            ),
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (active && activeScope.current === scope)
          setRead({
            scope,
            catalog: [],
            credentials: [],
            models: {},
            pages: {},
            providerErrors: {},
            selection: null,
            visibleModelIds: {},
            error: error instanceof ProviderClientOperationError
              ? error.message
              : "Provider models could not be loaded. Open provider setup to retry.",
          });
      });
    return () => {
      active = false;
    };
  }, [scope]);

  const current = read?.scope === scope ? read : null;
  const selectModel = async (
    providerId: string,
    modelId: string,
  ): Promise<void> => {
    if (!scope.client || !scope.enabled || !current || current.error || activeScope.current !== scope || saving)
      throw new Error("Provider model selection is not available yet.");
    if (
      !current.credentials.some(
        (credential) => credential.providerId === providerId,
      )
    ) {
      throw new Error("Connect this provider before selecting a model.");
    }
    const providerError = current.providerErrors[providerId];
    if (providerError) throw new Error(providerError);
    setSelectionError(null);
    setSaving(true);
    try {
      const selection = await scope.client.selectProvider(providerId, modelId);
      if (activeScope.current !== scope) throw new Error("Provider scope changed");
      setRead((value) =>
        value?.scope === scope ? { ...value, selection } : value,
      );
    } catch {
      if (activeScope.current === scope)
        setSelectionError("Provider model selection could not be saved.");
      throw new Error("Provider model selection could not be saved.");
    } finally {
      if (activeScope.current === scope) setSaving(false);
    }
  };
  const modelReads = useRef(new Map<string, Promise<ModelPickerModel[]>>());
  const latestRead = useRef<PickerRead | null>(null);
  latestRead.current = current;
  const [readingModels, setReadingModels] = useState<Record<string, boolean>>({});
  const readProviderModels = useCallback(async (providerId: string, refresh = false): Promise<ModelPickerModel[]> => {
    const reading = latestRead.current;
    const currentClient = scope.client;
    if (!reading || reading.scope !== scope || !currentClient || activeScope.current !== scope || !scope.enabled)
      throw new Error("Provider model discovery is not available yet.");
    if (!reading.credentials.some((item) => item.providerId === providerId))
      throw new Error("Connect this provider before discovering models.");
    const key = `${providerId}:${refresh ? "refresh" : "next"}`;
    const pending = modelReads.current.get(key);
    if (pending) return pending;
    const generation = (scope.modelReadGenerations.get(providerId) ?? 0) + 1;
    scope.modelReadGenerations.set(providerId, generation);
    setReadingModels((value) => ({ ...value, [providerId]: true }));
    const isReadCurrent = () => activeScope.current === scope && scope.modelReadGenerations.get(providerId) === generation;
    const assertReadCurrent = () => {
      if (!isReadCurrent()) throw new Error("Provider scope changed");
    };
    const request = (async () => {
      const previous = reading.pages[providerId];
      if (refresh) {
        await currentClient.refreshProviderModels(providerId);
        assertReadCurrent();
      } else if (!previous?.page.hasMore || !previous.page.nextCursor) return reading.models[providerId] ?? [];
      const page = refresh
        ? await loadDesktopPickerInventory(currentClient, providerId, reading.visibleModelIds[providerId] ?? new Set(),
            reading.selection?.providerId === providerId ? reading.selection.modelId : undefined, assertReadCurrent)
        : await currentClient.getProviderModels(providerId, undefined, {
            view: previous?.view ?? "popular", surface: "picker", limit: previous?.page.limit ?? 50,
            cursor: previous?.page.nextCursor,
          });
      assertReadCurrent();
      assertProviderModelDiscoveryAvailable(page);
      const models = refresh ? page.models : includeManagedPickerModels(
        reading.models[providerId] ?? [], page.models, new Set(page.models.map((model) => model.id)),
      );
      setRead((value) => {
        if (value?.scope !== scope) return value;
        const providerErrors = { ...value.providerErrors };
        delete providerErrors[providerId];
        return {
          ...value, error: null, providerErrors,
          models: { ...value.models, [providerId]: models },
          pages: { ...value.pages, [providerId]: page },
        };
      });
      setSelectionError(null);
      return models;
    })().catch((error: unknown) => {
      if (isReadCurrent()) {
        const message = error instanceof ProviderClientOperationError
          ? error.message : "Provider models could not be loaded. Retry discovery or open provider setup.";
        setRead((value) => value?.scope === scope ? {
          ...value, providerErrors: { ...value.providerErrors, [providerId]: message },
        } : value);
      }
      throw error;
    }).finally(() => {
      if (modelReads.current.get(key) === request) modelReads.current.delete(key);
      if (isReadCurrent()) setReadingModels((value) => ({ ...value, [providerId]: false }));
    });
    modelReads.current.set(key, request);
    return request;
  }, [scope]);
  const refreshModels = useCallback((providerId: string) =>
    readProviderModels(providerId, true).then(() => undefined), [readProviderModels]);
  const ensureModels = useCallback(async (providerId: string) => {
    const reading = latestRead.current;
    if (reading?.scope !== scope) return;
    const metadata = reading.pages[providerId]?.metadata;
    const fetchedAt = Date.parse(metadata?.fetchedAt ?? "");
    if (!metadata || metadata.stale || !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= PROVIDER_MODEL_CACHE_MAX_AGE_MS)
      await readProviderModels(providerId, true);
  }, [scope, readProviderModels]);
  // In-flight delivery identities belong to one client/grant/credential revision.
  useEffect(() => { modelReads.current.clear(); setReadingModels({}); }, [scope]);
  const selectedProvider = current?.selection?.providerId;
  const selectedCredentialPresent = Boolean(current && selectedProvider &&
    current.credentials.some((item) => item.providerId === selectedProvider));
  const selectedModel = current && selectedProvider
    ? current.models[selectedProvider]?.find((model) => model.id === current.selection?.modelId)
    : undefined;
  const selectedModelError = current && selectedProvider && selectedCredentialPresent
    ? current.providerErrors[selectedProvider] ??
      (!selectedModel || (selectedModel.availability !== undefined && selectedModel.availability !== "available")
        ? "The selected model is unavailable. Select another model or open provider setup."
        : null)
    : null;
  const unavailableReason = !scope.client || !scope.enabled
    ? "Desktop's provider connection is not ready. Reconnect to select a model."
    : !current
    ? "Loading the selected provider and model…"
    : (current.error ??
      (saving
        ? "Saving the selected provider and model…"
        : !current.selection
          ? "Select a provider and model before sending."
          : !current.credentials.some(
                (credential) =>
                  credential.providerId === current.selection?.providerId,
              )
            ? "Connect the selected provider before sending."
            : selectedModelError ?? undefined));

  return {
    current,
    selection: current?.selection ?? null,
    selectModel,
    unavailableReason,
    error: selectionError ?? current?.error ?? selectedModelError ?? null,
    providerErrors: current?.providerErrors ?? {},
    loading: Boolean(scope.client && scope.enabled && !current),
    saving,
    readingModels,
    loadMore: readProviderModels,
    refreshModels,
    ensureModels,
  };
}

export function DesktopModelPicker({
  controls,
  onConnectProvider,
  onManageModels,
  onModelSwitchWarning,
  disabled = false,
  selectionOverride,
}: {
  controls: ReturnType<typeof useDesktopModelPicker>;
  onConnectProvider: () => void;
  onManageModels: () => void;
  onModelSwitchWarning?: () => void;
  disabled?: boolean;
  selectionOverride?: NonNullable<Selection>;
}) {
  const { current } = controls;
  const selection = selectionOverride ?? controls.selection;
  return (
    <ModelPickerPopover
      policy={DESKTOP_PROVIDER_POLICY}
      disabled={disabled || controls.saving}
      catalog={current?.catalog ?? []}
      credentials={current?.credentials ?? []}
      providerModels={current?.models ?? {}}
      visibleModelIds={current?.visibleModelIds ?? {}}
      selectedProviderId={selection?.providerId ?? null}
      selectedModelId={selection?.modelId ?? null}
      onSelectModel={async (providerId, modelId) => {
        const changed = selection?.providerId !== providerId || selection?.modelId !== modelId;
        await controls.selectModel(providerId, modelId);
        if (changed) onModelSwitchWarning?.();
      }}
      selectedProviderMetadata={selection ? current?.pages[selection.providerId]?.metadata ?? null : null}
      isLoadingMoreSelectedProviderModels={selection ? controls.readingModels[selection.providerId] ?? false : false}
      hasMoreSelectedProviderModels={selection ? current?.pages[selection.providerId]?.page.hasMore ?? false : false}
      onLoadMoreSelectedProviderModels={controls.loadMore}
      onEnsureSelectedProviderModels={controls.ensureModels}
      onRefreshSelectedProviderModels={controls.refreshModels}
      onConnectProvider={onConnectProvider}
      onManageModels={onManageModels}
      isLoading={controls.loading}
    />
  );
}
