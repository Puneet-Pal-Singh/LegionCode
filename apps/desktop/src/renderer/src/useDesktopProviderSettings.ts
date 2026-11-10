import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadCompletePickerInventory,
  assertProviderModelDiscoveryAvailable,
  ProviderClientOperationError,
  loadManageProviderModelInventory,
  shouldLoadCompletePickerInventory,
  includeManagedPickerModels,
  type AppServerClient,
} from "@legioncode/sdk";
import type { LocalWorkspaceGrant } from "@repo/platform-protocol";
import {
  ProviderIdSchema,
  type BYOKPreference,
  type ProviderConnectionConfig,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import type {
  ProviderSettingsCredential,
  ProviderSettingsModel,
  ProviderSettingsPort,
} from "@legioncode/client-ui";
import type { DesktopCredentialStatus } from "../../shared/desktop-api";

type Scope = {
  client: AppServerClient;
  grant: Pick<LocalWorkspaceGrant, "workspaceId" | "grantedAt"> | null;
  credentialGeneration: Map<string, number>;
  inventoryGeneration: Map<string, number>;
  modelReads: Map<string, Promise<ProviderSettingsModel[]>>;
};
type Selection = Awaited<ReturnType<AppServerClient["getProviderSelection"]>>;
const unsupportedValidation =
  "Protected credentials can be replaced or disconnected here; saved keys are never read into this UI.";

async function currentPreferenceScope(scope: Scope, assertCurrent: (scope: Scope) => void) {
  if (!scope.grant) throw new Error("A granted workspace is required for model visibility.");
  const grant = await scope.client.getWorkspaceGrant();
  assertCurrent(scope);
  if (!grant || grant.readiness !== "ready" || grant.workspaceId !== scope.grant.workspaceId || grant.grantedAt !== scope.grant.grantedAt)
    throw new Error("Workspace access changed. Restore it before saving model visibility.");
  return { workspaceId: grant.workspaceId, grantedAt: grant.grantedAt };
}

/** Metadata projection and commands only; saved credential values stay in main. */
export function useDesktopProviderSettings(
  client: AppServerClient | null,
  enabled: boolean,
): ProviderSettingsPort {
  const active = useRef<Scope | null>(null);
  const [catalog, setCatalog] = useState<ProviderRegistryEntry[]>([]);
  const [credentials, setCredentials] = useState<ProviderSettingsCredential[]>(
    [],
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [preferences, setPreferences] = useState<BYOKPreference | null>(null);
  const [models, setModels] = useState<Record<string, ProviderSettingsModel[]>>(
    {},
  );
  const [manageModels, setManageModels] = useState<Record<string, ProviderSettingsModel[]>>({});
  const [manageLoading, setManageLoading] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<ProviderSettingsPort["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | undefined>();

  useEffect(() => {
    setCatalog([]);
    setCredentials([]);
    setSelection(null);
    setPreferences(null);
    setModels({});
    setManageModels({});
    setLoading({});
    setManageLoading({});
    setError(null);
    setModelError(null);
    setVisibilityBusy(false);
    setVisibilityError(undefined);
    if (!client || !enabled) {
      active.current = null;
      setStatus("idle");
      return;
    }
    const scope: Scope = { client, grant: null, credentialGeneration: new Map(), inventoryGeneration: new Map(), modelReads: new Map() };
    active.current = scope;
    setStatus("loading");
    void (async () => {
      const [providers, selected, grant] = await Promise.all([
        client.getProviderCatalog(),
        client.getProviderSelection(),
        client.getWorkspaceGrant(),
      ]);
      const statuses = await Promise.all(
        providers.map((entry) =>
          window.desktop.credential({
            operation: "status",
            providerId: ProviderIdSchema.parse(entry.providerId),
          }),
        ),
      );
      if (active.current !== scope) return;
      scope.grant =
        grant?.readiness === "ready"
          ? { workspaceId: grant.workspaceId, grantedAt: grant.grantedAt }
          : null;
      setCatalog(providers);
      setSelection(selected);
      const metadata = statuses.filter(
        (item): item is DesktopCredentialStatus =>
          !Array.isArray(item) && "status" in item,
      );
      setCredentials(
        metadata
          .filter((item) => item.status === "present")
          .map((item) => ({
            providerId: item.providerId,
            status: item.status,
          })),
      );
      if (metadata.some((item) => item.status === "unavailable"))
        setError(
          "Protected OS credential storage is unavailable for one or more providers.",
        );
      if (scope.grant) {
        try {
          const grant = await currentPreferenceScope(scope, (expected) => {
            if (active.current !== expected) throw new Error("Provider settings scope changed.");
          });
          const value = await client.readProviderPreferences(undefined, grant);
          if (active.current !== scope) return;
          setPreferences(value);
        } catch {
          if (active.current !== scope) return;
          setVisibilityError(
            "Workspace model visibility could not be loaded. Close settings and restore workspace access before retrying.",
          );
        }
      } else
        setVisibilityError(
          "Open a granted workspace to save its model visibility preferences.",
        );
      if (active.current === scope) setStatus("ready");
    })().catch(() => {
      if (active.current === scope) {
        setStatus("error");
        setError(
          "Provider configuration could not be loaded. Close settings and retry.",
        );
      }
    });
    return () => {
      if (active.current === scope) active.current = null;
    };
  }, [client, enabled]);

  const requireScope = useCallback((): Scope => {
    const scope = active.current;
    if (!scope || scope.client !== client || !enabled)
      throw new Error("Provider settings scope changed.");
    return scope;
  }, [client, enabled]);
  const assertCurrent = useCallback((scope: Scope) => {
    if (active.current !== scope)
      throw new Error("Provider settings scope changed.");
  }, []);

  const loadInventory = useCallback(
    (providerId: string, surface: "picker" | "manage", limit = 150): Promise<ProviderSettingsModel[]> => {
      const scope = requireScope();
      providerId = ProviderIdSchema.parse(providerId);
      const generation = scope.credentialGeneration.get(providerId) ?? 0;
      const inventoryGeneration = scope.inventoryGeneration.get(providerId) ?? 0;
      const key = `${providerId}:${generation}:${inventoryGeneration}:${surface}:${limit}`;
      const pending = scope.modelReads.get(key);
      if (pending) return pending;
      const setBusy = surface === "manage" ? setManageLoading : setLoading;
      setBusy((current) => ({ ...current, [providerId]: true }));
      const isReadCurrent = () => active.current === scope &&
        (scope.credentialGeneration.get(providerId) ?? 0) === generation &&
        (scope.inventoryGeneration.get(providerId) ?? 0) === inventoryGeneration;
      const assertReadCurrent = () => {
        assertCurrent(scope);
        if (!isReadCurrent()) throw new Error("Provider credential changed during model discovery.");
      };
      const loadPage = async (query: Parameters<AppServerClient["getProviderModels"]>[2]) => {
        assertReadCurrent();
        const page = await scope.client.getProviderModels(providerId, undefined, query);
        assertReadCurrent();
        assertProviderModelDiscoveryAvailable(page);
        return page;
      };
      const request = (async () => {
        const response = surface === "manage"
          ? await loadManageProviderModelInventory({ providerId, limit, loadPage })
          : shouldLoadCompletePickerInventory({ providerId, view: "all", surface, append: false })
            ? await loadCompletePickerInventory({ providerId, loadPage })
            : await loadPage({ view: "popular", surface: "picker", limit: 50 });
        assertReadCurrent();
        if (surface === "manage") setManageModels((current) => ({ ...current, [providerId]: response.models }));
        else setModels((current) => ({ ...current, [providerId]: response.models }));
        setModelError(null);
        return response.models;
      })().catch((error: unknown) => {
        if (isReadCurrent()) setModelError(error instanceof ProviderClientOperationError
          ? error.message : "Provider models could not be loaded. Retry model discovery.");
        throw error;
      }).finally(() => {
        if (scope.modelReads.get(key) === request) scope.modelReads.delete(key);
        if (isReadCurrent())
          setBusy((current) => ({ ...current, [providerId]: false }));
      });
      scope.modelReads.set(key, request);
      return request;
    },
    [requireScope, assertCurrent],
  );
  const loadModels = useCallback(async (providerId: string) => loadInventory(providerId, "picker"), [loadInventory]);
  const loadManageModels = useCallback(async (providerId: string, limit = 150) => loadInventory(providerId, "manage", limit), [loadInventory]);

  const connectCredential = useCallback(
    async (request: {
      providerId: string;
      secret: string;
      label?: string;
      config?: ProviderConnectionConfig;
    }) => {
      const scope = requireScope();
      const providerId = ProviderIdSchema.parse(request.providerId);
      if (!catalog.some((entry) => entry.providerId === providerId))
        throw new Error("This provider is not available.");
      const generation = (scope.credentialGeneration.get(providerId) ?? 0) + 1;
      scope.credentialGeneration.set(providerId, generation);
      setLoading((current) => ({ ...current, [providerId]: false }));
      setManageLoading((current) => ({ ...current, [providerId]: false }));
      const assertCredentialCurrent = () => {
        assertCurrent(scope);
        if (scope.credentialGeneration.get(providerId) !== generation) throw new Error("Provider credential changed.");
      };
      let saved = false;
      let confirmedStatus: DesktopCredentialStatus | null = null;
      try {
        await window.desktop.credential({
          operation: "save",
          request: {
            providerId,
            apiKey: request.secret,
            ...(request.config ? { config: request.config } : {}),
          },
        });
        saved = true;
        assertCredentialCurrent();
        const receipt = await window.desktop.credential({
          operation: "status",
          providerId,
        });
        assertCredentialCurrent();
        if (
          Array.isArray(receipt) ||
          !("status" in receipt) ||
          receipt.status !== "present"
        )
          throw new Error(
            "Protected credential storage did not confirm the save.",
          );
        confirmedStatus = receipt;
        await scope.client.refreshProviderModels(providerId);
        assertCredentialCurrent();
        // Invalidate in-flight catalog deliveries from before this refresh;
        // the protected credential generation remains unchanged.
        scope.inventoryGeneration.set(providerId, (scope.inventoryGeneration.get(providerId) ?? 0) + 1);
        setModels((current) => {
          const next = { ...current }; delete next[providerId]; return next;
        });
        setManageModels((current) => {
          const next = { ...current }; delete next[providerId]; return next;
        });
        setLoading((current) => ({ ...current, [providerId]: false }));
        setManageLoading((current) => ({ ...current, [providerId]: false }));
        setCredentials((current) => [
          ...current.filter((item) => item.providerId !== providerId),
          { providerId, status: receipt.status },
        ]);
        const discovered = await loadModels(providerId);
        assertCredentialCurrent();
        const first = discovered.find(
          (model) => model.availability !== "unsupported_transport",
        );
        if (first) {
          const selected = await scope.client.selectProvider(
            providerId,
            first.id,
          );
          assertCredentialCurrent();
          setSelection(selected);
        }
        setError(null);
      } catch {
        if (confirmedStatus && active.current === scope && scope.credentialGeneration.get(providerId) === generation) {
          const actualStatus = confirmedStatus.status;
          setCredentials((current) => [
            ...current.filter((item) => item.providerId !== providerId),
            { providerId, status: actualStatus },
          ]);
        }
        throw new Error(
          saved
            ? "Credential saved in protected storage, but model selection could not be completed. Retry model selection."
            : "Provider credential could not be saved. Check protected OS storage and retry.",
        );
      }
    },
    [catalog, requireScope, assertCurrent, loadModels],
  );

  const disconnectCredential = useCallback(
    async (credential: ProviderSettingsCredential) => {
      const scope = requireScope();
      const providerId = ProviderIdSchema.parse(credential.providerId);
      const generation = (scope.credentialGeneration.get(providerId) ?? 0) + 1;
      scope.credentialGeneration.set(providerId, generation);
      setLoading((current) => ({ ...current, [providerId]: false }));
      setManageLoading((current) => ({ ...current, [providerId]: false }));
      const assertCredentialCurrent = () => {
        assertCurrent(scope);
        if (scope.credentialGeneration.get(providerId) !== generation) throw new Error("Provider credential changed.");
      };
      try {
        await window.desktop.credential({ operation: "delete", providerId });
        assertCredentialCurrent();
        setCredentials((current) =>
          current.filter((item) => item.providerId !== providerId),
        );
        setModels((current) => {
          const next = { ...current };
          delete next[providerId];
          return next;
        });
        setManageModels((current) => {
          const next = { ...current }; delete next[providerId]; return next;
        });
        setLoading((current) => ({ ...current, [providerId]: false }));
        setManageLoading((current) => ({ ...current, [providerId]: false }));
        if (selection?.providerId === providerId) {
          await scope.client.clearProviderSelection();
          assertCredentialCurrent();
          setSelection(null);
        }
        setError(null);
      } catch {
        if (active.current === scope && scope.credentialGeneration.get(providerId) === generation)
          setError("Provider credential could not be disconnected.");
        throw new Error("Provider credential could not be disconnected.");
      }
    },
    [requireScope, assertCurrent, selection],
  );

  const applySessionSelection = useCallback(
    async (request: { providerId: string; modelId?: string }) => {
      const scope = requireScope();
      if (!request.modelId)
        throw new Error("Choose an available provider model.");
      const selected = await scope.client.selectProvider(
        request.providerId,
        request.modelId,
      );
      assertCurrent(scope);
      setSelection(selected);
      return selected;
    },
    [requireScope, assertCurrent],
  );

  const saveVisibility = useCallback(
    (providerId: string, modelIds: string[]) => {
      const scope = requireScope();
      if (!scope.grant || !preferences || visibilityBusy) return;
      setVisibilityBusy(true);
      setError(null);
      const visibleModelIds = {
        ...preferences.visibleModelIds,
        [providerId]: modelIds,
      };
      void currentPreferenceScope(scope, assertCurrent)
        .then((grant) => {
          assertCurrent(scope);
          return scope.client.updateProviderPreferences(undefined, { visibleModelIds }, grant);
        })
        .then((value) => {
          assertCurrent(scope);
          setPreferences(value);
          setVisibilityError(undefined);
        })
        .catch(() => {
          if (active.current === scope)
            setError("Model visibility could not be saved. Restore workspace access and retry.");
        })
        .finally(() => {
          if (active.current === scope) setVisibilityBusy(false);
        });
    },
    [requireScope, assertCurrent, preferences, visibilityBusy],
  );
  const toggleModelVisibility = useCallback(
    (providerId: string, modelId: string) => {
      const current = new Set(
        preferences?.visibleModelIds[providerId] ??
          manageModels[providerId]?.map((model) => model.id) ??
          models[providerId]?.map((model) => model.id) ??
          [],
      );
      if (current.has(modelId)) current.delete(modelId);
      else current.add(modelId);
      saveVisibility(providerId, [...current]);
    },
    [preferences, manageModels, models, saveVisibility],
  );
  const visibleModelIds = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(preferences?.visibleModelIds ?? {}).map(
          ([providerId, ids]) => [providerId, new Set(ids)],
        ),
      ),
    [preferences],
  );

  const pickerModels = useMemo(() => Object.fromEntries(
    [...new Set([...Object.keys(models), ...Object.keys(manageModels)])].map((providerId) => [
      providerId,
      includeManagedPickerModels(models[providerId] ?? [], manageModels[providerId] ?? [], visibleModelIds[providerId],
        selection?.providerId === providerId ? selection.modelId : undefined),
    ]),
  ), [models, manageModels, visibleModelIds, selection]);

  return {
    status: error || modelError ? "error" : status,
    error: modelError ?? error,
    catalog,
    credentials,
    providerModels: pickerModels,
    manageProviderModels: manageModels,
    visibleModelIds,
    loadingModelsForProviderId:
      Object.keys(loading).find((providerId) => loading[providerId]) ?? null,
    loadingManageModelsForProviderIds: manageLoading,
    preferences,
    selectedProviderId: selection?.providerId ?? null,
    selectedCredentialId: null,
    selectedModelId: selection?.modelId ?? null,
    connectCredential,
    disconnectCredential,
    applySessionSelection,
    loadProviderModels: loadModels,
    loadManageProviderModels: loadManageModels,
    validateCredential: async () => {
      throw new Error(unsupportedValidation);
    },
    toggleModelVisibility,
    setProviderVisibleModels: saveVisibility,
    visibilityUnavailableReason: visibilityBusy
      ? "Saving model visibility…"
      : visibilityError,
    credentialValidationUnavailableReason: unsupportedValidation,
  };
}
