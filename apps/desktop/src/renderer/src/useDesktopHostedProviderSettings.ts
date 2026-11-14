import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  assertProviderModelDiscoveryAvailable,
  deriveSelectionSnapshot,
  includeManagedPickerModels,
  loadCompletePickerInventory,
  loadManageProviderModelInventory,
  PROVIDER_MODEL_CACHE_MAX_AGE_MS,
  shouldLoadCompletePickerInventory,
  type AppServerClient,
  type ProviderSelectionSnapshot,
} from "@legioncode/sdk";
import { HostedSessionParamsSchema, RunIdSchema } from "@repo/platform-protocol";
import type { BYOKCredential, BYOKPreference, BYOKResolution, ProviderRegistryEntry } from "@repo/shared-types";
import type { ProviderSettingsCredential, ProviderSettingsModel, ProviderSettingsPort } from "@legioncode/client-ui";
import { HostedRequestScopeSchema, type HostedRequestScope } from "../../shared/hosted-request";

export type DesktopHostedProviderBinding = HostedRequestScope & {
  workspaceId: string;
  runId?: string;
  sessionId?: string;
};
type Page = Awaited<ReturnType<AppServerClient["getProviderModels"]>>;
type Snapshot = {
  status: ProviderSettingsPort["status"];
  error: string | null;
  catalog: ProviderRegistryEntry[];
  credentials: BYOKCredential[];
  preferences: BYOKPreference | null;
  pages: Record<string, Page>;
  manageModels: Record<string, ProviderSettingsModel[]>;
  loadingModels: Record<string, boolean>;
  loadingManageModels: Record<string, boolean>;
  selected: ProviderSelectionSnapshot;
  resolution: BYOKResolution | null;
};
type Scope = {
  client: AppServerClient;
  binding: Readonly<DesktopHostedProviderBinding>;
  snapshot: Snapshot;
  revision: number;
  reads: Map<string, Promise<ProviderSettingsModel[]>>;
  writes: Promise<void>;
  explicitSelection: boolean;
  pickerVersions: Map<string, number>;
};
const noSelection: ProviderSelectionSnapshot = {
  selectedProviderId: null, selectedCredentialId: null, selectedModelId: null,
};
function emptySnapshot(): Snapshot {
  return { status: "loading", error: null, catalog: [], credentials: [], preferences: null,
    pages: {}, manageModels: {}, loadingModels: {}, loadingManageModels: {}, selected: noSelection, resolution: null };
}
function visibleModels(preferences: BYOKPreference | null): Record<string, Set<string>> {
  return Object.fromEntries(Object.entries(preferences?.visibleModelIds ?? {}).map(([id, models]) => [id, new Set(models)]));
}
function selectionUnavailableReason(snapshot: Snapshot, selected: ProviderSelectionSnapshot): string | null {
  const { selectedProviderId: providerId, selectedCredentialId: credentialId, selectedModelId: modelId } = selected;
  if (!providerId || !credentialId || !modelId) return "Select a connected provider and model before sending.";
  if (!snapshot.credentials.some((item) => item.providerId === providerId && item.credentialId === credentialId))
    return "The selected hosted credential is unavailable.";
  const visible = visibleModels(snapshot.preferences)[providerId];
  const model = snapshot.pages[providerId]?.models.find((item) => item.id === modelId);
  return !model || (model.availability !== undefined && model.availability !== "available") || (visible && !visible.has(modelId))
    ? "The selected hosted model is unavailable or hidden." : null;
}
function verifyOwner(scope: Scope, value: { userId: string; workspaceId: string }): void {
  if (value.userId !== scope.binding.accountId || value.workspaceId !== scope.binding.workspaceId)
    throw new Error("Hosted provider response belongs to a different account or workspace.");
}

/** A scope-tagged presentation projection over hosted provider SDK commands. */
export function useDesktopHostedProviderSettings({ client, binding, enabled = true, initialSelection }: {
  client: AppServerClient | null;
  binding: DesktopHostedProviderBinding | null;
  enabled?: boolean;
  /** Exact prior selection supplied by the host's same-account welcome/session handoff. */
  initialSelection?: Pick<BYOKResolution, "providerId" | "credentialId" | "modelId"> | null;
}) {
  const scope = useMemo<Scope | null>(() => {
    if (!client || !binding || !enabled) return null;
    if (!binding.workspaceId.trim()) throw new Error("A hosted workspace is required.");
    if (binding.sessionId) HostedSessionParamsSchema.parse({ sessionId: binding.sessionId });
    const snapshot = emptySnapshot();
    if (initialSelection) snapshot.selected = {
      selectedProviderId: initialSelection.providerId, selectedCredentialId: initialSelection.credentialId,
      selectedModelId: initialSelection.modelId,
    };
    return { client, binding: Object.freeze({ ...HostedRequestScopeSchema.parse({
      target: binding.target, accountId: binding.accountId, generation: binding.generation,
    }), workspaceId: binding.workspaceId,
      runId: binding.runId === undefined ? undefined : RunIdSchema.parse(binding.runId), sessionId: binding.sessionId }),
      snapshot, revision: 0, reads: new Map(), writes: Promise.resolve(), explicitSelection: Boolean(initialSelection),
      pickerVersions: new Map() };
  }, [client, binding?.target, binding?.accountId, binding?.generation, binding?.workspaceId, binding?.runId, binding?.sessionId,
    enabled, initialSelection?.providerId, initialSelection?.credentialId, initialSelection?.modelId]);
  const active = useRef<Scope | null>(scope);
  const [read, setRead] = useState<{ scope: Scope; value: Snapshot } | null>(null);
  useLayoutEffect(() => {
    active.current = scope;
    return () => { if (active.current === scope) active.current = null; };
  }, [scope]);
  const requireCurrent = useCallback((expected = scope): Scope => {
    if (!expected || active.current !== expected) throw new DOMException("Hosted provider scope changed.", "AbortError");
    return expected;
  }, [scope]);
  const publish = useCallback((expected: Scope, patch: Partial<Snapshot>) => {
    requireCurrent(expected);
    expected.snapshot = { ...expected.snapshot, ...patch };
    setRead({ scope: expected, value: expected.snapshot });
  }, [requireCurrent]);

  const loadPage = useCallback(async (expected: Scope, providerId: string,
    query: Parameters<AppServerClient["getProviderModels"]>[2], revision = expected.revision): Promise<Page> => {
    requireCurrent(expected);
    if (revision !== expected.revision) throw new DOMException("Hosted provider inventory changed.", "AbortError");
    const page = await expected.client.getProviderModels(providerId, expected.binding.runId, query);
    requireCurrent(expected);
    if (revision !== expected.revision || page.providerId !== providerId)
      throw new DOMException("Hosted provider inventory changed.", "AbortError");
    assertProviderModelDiscoveryAvailable(page);
    return page;
  }, [requireCurrent]);

  const pickerPage = useCallback(async (expected: Scope, providerId: string, preferences: BYOKPreference | null,
    selectedModelId?: string): Promise<Page> => {
    const revision = expected.revision;
    const load = (query: Parameters<AppServerClient["getProviderModels"]>[2]) => loadPage(expected, providerId, query, revision);
    const page = shouldLoadCompletePickerInventory({ providerId, view: "all", surface: "picker", append: false })
      ? await loadCompletePickerInventory({ providerId, loadPage: load })
      : await load({ view: "popular", surface: "picker", limit: 50 });
    const visible = visibleModels(preferences)[providerId];
    const missing = [...(visible ?? []), ...(selectedModelId ? [selectedModelId] : [])]
      .some((id) => !page.models.some((model) => model.id === id));
    const managed = missing ? await loadManageProviderModelInventory({ providerId, loadPage: load }) : null;
    return { ...page, models: includeManagedPickerModels(page.models, managed?.models ?? [], visible, selectedModelId) };
  }, [loadPage]);

  const resolveSelection = useCallback(async (expected: Scope, selected: ProviderSelectionSnapshot): Promise<BYOKResolution> => {
    requireCurrent(expected);
    const { selectedProviderId: providerId, selectedCredentialId: credentialId, selectedModelId: modelId } = selected;
    const unavailableReason = selectionUnavailableReason(expected.snapshot, selected);
    if (unavailableReason || !providerId || !credentialId || !modelId)
      throw new Error(unavailableReason ?? "Select a connected provider and model before sending.");
    const resolved = await expected.client.resolveProviderPreferences(expected.binding.runId, {
      providerId, credentialId, modelId, sessionId: expected.binding.sessionId,
    });
    requireCurrent(expected);
    if (resolved.providerId !== providerId || resolved.credentialId !== credentialId || resolved.modelId !== modelId)
      throw new Error("Hosted provider resolution changed the selected provider, credential or model.");
    return resolved;
  }, [requireCurrent]);

  const reload = useCallback(async (): Promise<void> => {
    const expected = requireCurrent();
    const revision = ++expected.revision;
    expected.reads.clear();
    publish(expected, { status: "loading", error: null, resolution: null, loadingModels: {}, loadingManageModels: {} });
    const [catalog, credentials, preferences] = await Promise.all([
      expected.client.getProviderCatalog(expected.binding.runId),
      expected.client.listProviderCredentials(expected.binding.runId),
      expected.client.readProviderPreferences(expected.binding.runId),
    ]);
    requireCurrent(expected);
    if (revision !== expected.revision) throw new DOMException("Hosted provider inventory changed.", "AbortError");
    verifyOwner(expected, preferences);
    for (const credential of credentials) verifyOwner(expected, credential);
    const connected = credentials.filter((item) => item.status === "connected" && item.deletedAt === null);
    const inventories = await Promise.allSettled([...new Set(connected.map((item) => item.providerId))].map(async (id) =>
      [id, await pickerPage(expected, id, preferences,
        expected.snapshot.selected.selectedProviderId === id ? expected.snapshot.selected.selectedModelId ?? undefined
          : preferences.defaultProviderId === id ? preferences.defaultModelId : undefined)] as const));
    requireCurrent(expected);
    if (revision !== expected.revision) throw new DOMException("Hosted provider inventory changed.", "AbortError");
    const pages = Object.fromEntries(inventories.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
    const selected = deriveSelectionSnapshot({ catalog, credentials: connected, preferences,
      providerModels: Object.fromEntries(Object.entries(pages).map(([id, page]) => [id, page.models])),
      visibleModelIds: visibleModels(preferences), ...expected.snapshot.selected,
      hasExplicitSessionSelection: expected.explicitSelection });
    publish(expected, { catalog, credentials: connected, preferences, pages, selected,
      status: "ready", error: inventories.some((item) => item.status === "rejected") ? "Some hosted provider models could not be loaded. Retry discovery." : null });
    if (selected.selectedProviderId && selected.selectedCredentialId && selected.selectedModelId) {
      try {
        const resolution = await resolveSelection(expected, selected);
        if (revision === expected.revision) publish(expected, { resolution });
      } catch (error) {
        requireCurrent(expected);
        if (revision !== expected.revision) throw new DOMException("Hosted provider inventory changed.", "AbortError");
        publish(expected, { resolution: null, error: "The selected hosted provider or model is unavailable. Choose another model or reconnect the provider." });
      }
    }
  }, [requireCurrent, publish, pickerPage, resolveSelection]);
  useEffect(() => {
    if (!scope) return;
    void reload().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (active.current === scope) publish(scope, { status: "error", error: "Hosted provider configuration could not be loaded. Retry provider setup." });
    });
  }, [scope, reload, publish]);

  const write = useCallback(<T,>(operation: (expected: Scope) => Promise<T>): Promise<T> => {
    const expected = requireCurrent();
    const pending = expected.writes.then(async () => {
      requireCurrent(expected);
      const result = await operation(expected);
      requireCurrent(expected);
      return result;
    });
    expected.writes = pending.then(() => undefined, () => undefined);
    return pending.catch((error: unknown) => {
      if (active.current === expected && !(error instanceof DOMException && error.name === "AbortError"))
        publish(expected, { error: "The hosted provider change could not be confirmed. Reload before retrying.", resolution: null });
      throw error;
    });
  }, [requireCurrent, publish]);

  const loadModels = useCallback((providerId: string, surface: "picker" | "manage", limit?: number): Promise<ProviderSettingsModel[]> => {
    const expected = requireCurrent();
    const revision = expected.revision;
    const key = `${revision}:${providerId}:${surface}:${limit ?? 150}`;
    const existing = expected.reads.get(key);
    if (existing) return existing;
    if (!expected.snapshot.credentials.some((credential) => credential.providerId === providerId))
      return Promise.reject(new Error("Connect this hosted provider before discovering models."));
    const loadingKey = surface === "manage" ? "loadingManageModels" : "loadingModels";
    const pickerVersion = (expected.pickerVersions.get(providerId) ?? 0) + 1;
    if (surface === "picker") expected.pickerVersions.set(providerId, pickerVersion);
    publish(expected, { [loadingKey]: { ...expected.snapshot[loadingKey], [providerId]: true } });
    const pending = (async () => {
      const page = surface === "manage"
        ? await loadManageProviderModelInventory({ providerId, limit, loadPage: (query) => loadPage(expected, providerId, query, revision) })
        : await pickerPage(expected, providerId, expected.snapshot.preferences,
          expected.snapshot.selected.selectedProviderId === providerId ? expected.snapshot.selected.selectedModelId ?? undefined : undefined);
      requireCurrent(expected);
      if (revision !== expected.revision || (surface === "picker" && expected.pickerVersions.get(providerId) !== pickerVersion))
        throw new DOMException("Hosted provider inventory changed.", "AbortError");
      publish(expected, surface === "manage"
        ? { manageModels: { ...expected.snapshot.manageModels, [providerId]: page.models } }
        : { pages: { ...expected.snapshot.pages, [providerId]: page } });
      return page.models;
    })().catch((error: unknown) => {
      if (active.current === expected && revision === expected.revision &&
          (surface === "manage" || expected.pickerVersions.get(providerId) === pickerVersion))
        publish(expected, { error: "Hosted model discovery could not be completed. Retry discovery." });
      throw error;
    }).finally(() => {
      if (expected.reads.get(key) === pending) expected.reads.delete(key);
      if (active.current === expected && revision === expected.revision &&
          (surface === "manage" || expected.pickerVersions.get(providerId) === pickerVersion))
        publish(expected, { [loadingKey]: { ...expected.snapshot[loadingKey], [providerId]: false } });
    });
    expected.reads.set(key, pending);
    return pending;
  }, [requireCurrent, publish, loadPage, pickerPage]);

  const applySessionSelection: ProviderSettingsPort["applySessionSelection"] = useCallback((request) => write(async (expected) => {
    if (!request.credentialId) throw new Error("Select the exact hosted provider credential.");
    const selected = { selectedProviderId: request.providerId, selectedCredentialId: request.credentialId,
      selectedModelId: request.modelId ?? expected.snapshot.selected.selectedModelId };
    if (!expected.snapshot.pages[request.providerId]?.models.some((model) => model.id === selected.selectedModelId))
      await loadModels(request.providerId, "picker");
    const resolution = await resolveSelection(expected, selected);
    expected.explicitSelection = true;
    publish(expected, { selected, resolution, error: null });
    return resolution;
  }), [write, loadModels, resolveSelection, publish]);
  const selectModel = useCallback(async (providerId: string, modelId: string): Promise<void> => {
    const expected = requireCurrent();
    const credentialId = expected.snapshot.credentials.find((item) => item.providerId === providerId &&
      item.credentialId === expected.snapshot.selected.selectedCredentialId)?.credentialId
      ?? expected.snapshot.credentials.find((item) => item.providerId === providerId)?.credentialId;
    if (!credentialId) throw new Error("Connect this hosted provider before selecting a model.");
    await applySessionSelection({ providerId, credentialId, modelId });
  }, [requireCurrent, applySessionSelection]);
  const persistVisibility = useCallback((providerId: string, next: (expected: Scope) => string[]) => {
    void write(async (expected) => {
      const revision = expected.revision;
      const selected = Object.freeze({ ...expected.snapshot.selected });
      const assertUnchanged = () => {
        requireCurrent(expected);
        const current = expected.snapshot.selected;
        if (revision !== expected.revision || current.selectedProviderId !== selected.selectedProviderId ||
            current.selectedCredentialId !== selected.selectedCredentialId || current.selectedModelId !== selected.selectedModelId)
          throw new DOMException("Hosted provider selection changed.", "AbortError");
      };
      const preferences = await expected.client.updateProviderPreferences(expected.binding.runId, {
        visibleModelIds: { ...expected.snapshot.preferences?.visibleModelIds, [providerId]: [...new Set(next(expected))] },
      });
      assertUnchanged();
      verifyOwner(expected, preferences);
      publish(expected, { preferences, error: null, resolution: null });
      await loadModels(providerId, "picker");
      assertUnchanged();
      if (selectionUnavailableReason(expected.snapshot, selected)) return;
      const pickerVersion = expected.pickerVersions.get(selected.selectedProviderId ?? "");
      const resolution = await resolveSelection(expected, selected);
      assertUnchanged();
      if (expected.pickerVersions.get(selected.selectedProviderId ?? "") !== pickerVersion ||
          selectionUnavailableReason(expected.snapshot, selected)) return;
      publish(expected, { resolution });
    }).catch(() => undefined);
  }, [write, requireCurrent, publish, loadModels, resolveSelection]);
  const updateVisibility = useCallback((providerId: string, ids: string[]) =>
    persistVisibility(providerId, () => [...ids]), [persistVisibility]);
  const current = read?.scope === scope ? read.value : null;
  const snapshot = current ?? emptySnapshot();
  const provider: ProviderSettingsPort = {
    status: scope ? snapshot.status : "idle", error: snapshot.error,
    catalog: snapshot.catalog,
    credentials: snapshot.credentials.map(({ providerId, credentialId, label, keyFingerprint, status }) =>
      ({ providerId, credentialId, label, keyFingerprint, status })),
    providerModels: Object.fromEntries(Object.entries(snapshot.pages).map(([id, page]) => [id, page.models])),
    manageProviderModels: snapshot.manageModels,
    visibleModelIds: visibleModels(snapshot.preferences),
    loadingModelsForProviderId: Object.keys(snapshot.loadingModels).find((id) => snapshot.loadingModels[id]) ?? null,
    loadingManageModelsForProviderIds: snapshot.loadingManageModels,
    preferences: snapshot.preferences, ...snapshot.selected,
    connectCredential: (request) => write(async (expected) => {
      const credential = await expected.client.connectProviderCredential(expected.binding.runId, request);
      requireCurrent(expected);
      verifyOwner(expected, credential);
      await reload();
    }),
    disconnectCredential: (credential) => write(async (expected) => {
      await expected.client.disconnectProviderCredential(expected.binding.runId, requireCredential(expected, credential));
      requireCurrent(expected);
      if (credential.credentialId === expected.snapshot.selected.selectedCredentialId) {
        expected.explicitSelection = false;
        publish(expected, { selected: noSelection, resolution: null });
      }
      await reload();
    }),
    validateCredential: (credential, mode) => write(async (expected) => {
      const id = requireCredential(expected, credential);
      const result = await expected.client.validateProviderCredential(expected.binding.runId, id, { mode });
      requireCurrent(expected);
      if (result.credentialId !== id || !result.valid) throw new Error("Hosted credential validation failed.");
      await reload();
    }),
    loadProviderModels: (id) => loadModels(id, "picker"),
    loadManageProviderModels: (id, limit) => loadModels(id, "manage", limit),
    applySessionSelection,
    toggleModelVisibility: (id, modelId) => {
      persistVisibility(id, (expected) => {
        const ids = new Set(expected.snapshot.preferences?.visibleModelIds[id]
          ?? (expected.snapshot.manageModels[id] ?? expected.snapshot.pages[id]?.models ?? []).map((model) => model.id));
        if (ids.has(modelId)) ids.delete(modelId); else ids.add(modelId);
        return [...ids];
      });
    },
    setProviderVisibleModels: updateVisibility,
  };
  const refreshModels = useCallback(async (providerId: string): Promise<void> => {
    const expected = requireCurrent();
    await expected.client.refreshProviderModels(providerId, expected.binding.runId);
    requireCurrent(expected);
    await loadModels(providerId, "picker");
  }, [requireCurrent, loadModels]);
  const ensureModels = useCallback(async (providerId: string): Promise<void> => {
    const metadata = requireCurrent().snapshot.pages[providerId]?.metadata;
    const timestamp = Date.parse(metadata?.fetchedAt ?? "");
    if (!metadata || metadata.stale || !Number.isFinite(timestamp) || Date.now() - timestamp >= PROVIDER_MODEL_CACHE_MAX_AGE_MS)
      await refreshModels(providerId);
  }, [requireCurrent, refreshModels]);
  const loadMore = useCallback(async (providerId: string): Promise<ProviderSettingsModel[]> => {
    const expected = requireCurrent();
    const revision = expected.revision;
    const previous = expected.snapshot.pages[providerId];
    if (!previous?.page.hasMore) return previous?.models ?? [];
    if (!previous.page.nextCursor) throw new Error("Hosted model discovery did not provide its next page.");
    const key = `more:${revision}:${providerId}:${previous.page.nextCursor}`;
    const existing = expected.reads.get(key);
    if (existing) return existing;
    const pickerVersion = (expected.pickerVersions.get(providerId) ?? 0) + 1;
    expected.pickerVersions.set(providerId, pickerVersion);
    publish(expected, { loadingModels: { ...expected.snapshot.loadingModels, [providerId]: true } });
    const pending = (async () => {
      const page = await loadPage(expected, providerId, { view: previous.view, surface: "picker", limit: previous.page.limit, cursor: previous.page.nextCursor }, revision);
      if (expected.pickerVersions.get(providerId) !== pickerVersion)
        throw new DOMException("Hosted provider inventory changed.", "AbortError");
      if (page.page.hasMore && page.page.nextCursor === previous.page.nextCursor)
        throw new Error("Hosted model discovery repeated its continuation cursor.");
      const models = [...new Map([...previous.models, ...page.models].map((item) => [item.id, item])).values()];
      publish(expected, { pages: { ...expected.snapshot.pages, [providerId]: { ...page, models } } });
      return models;
    })().catch((error: unknown) => {
      if (active.current === expected && expected.revision === revision && expected.pickerVersions.get(providerId) === pickerVersion)
        publish(expected, { error: "More hosted provider models could not be loaded. Retry discovery." });
      throw error;
    }).finally(() => {
      if (expected.reads.get(key) === pending) expected.reads.delete(key);
      if (active.current === expected && expected.revision === revision && expected.pickerVersions.get(providerId) === pickerVersion)
        publish(expected, { loadingModels: { ...expected.snapshot.loadingModels, [providerId]: false } });
    });
    expected.reads.set(key, pending);
    return pending;
  }, [requireCurrent, loadPage, publish]);
  return { provider, selection: snapshot.resolution, reload, selectModel,
    resolveForSubmission: () => write(async (expected) => {
      const resolution = await resolveSelection(expected, expected.snapshot.selected);
      publish(expected, { resolution, error: null });
      return resolution;
    }),
    picker: { pages: snapshot.pages, loadingModels: snapshot.loadingModels, refreshModels, ensureModels, loadMore },
    unavailableReason: !scope ? "Sign in and select a hosted workspace before choosing a provider."
      : snapshot.status !== "ready" ? "Loading hosted provider configuration…"
        : snapshot.resolution ? undefined : "Select an available hosted provider and model before sending.",
  };
}

function requireCredential(scope: Scope, credential: ProviderSettingsCredential): string {
  if (!credential.credentialId || !scope.snapshot.credentials.some((item) =>
    item.credentialId === credential.credentialId && item.providerId === credential.providerId))
    throw new Error("The hosted credential is unavailable in this workspace.");
  return credential.credentialId;
}
