import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppServerClient } from "@legioncode/sdk";
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
};
type Selection = Awaited<ReturnType<AppServerClient["getProviderSelection"]>>;
const unsupportedValidation =
  "Protected credentials can be replaced or disconnected here; saved keys are never read into this UI.";

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
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<ProviderSettingsPort["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | undefined>();

  useEffect(() => {
    setCatalog([]);
    setCredentials([]);
    setSelection(null);
    setPreferences(null);
    setModels({});
    setError(null);
    setVisibilityBusy(false);
    setVisibilityError(undefined);
    if (!client || !enabled) {
      active.current = null;
      setStatus("idle");
      return;
    }
    const scope: Scope = { client, grant: null };
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
          const value = await client.readProviderPreferences(
            undefined,
            scope.grant,
          );
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

  const loadModels = useCallback(
    async (providerId: string): Promise<ProviderSettingsModel[]> => {
      const scope = requireScope();
      setLoading((current) => ({ ...current, [providerId]: true }));
      try {
        const response = await scope.client.getProviderModels(
          ProviderIdSchema.parse(providerId),
        );
        assertCurrent(scope);
        setModels((current) => ({ ...current, [providerId]: response.models }));
        return response.models;
      } catch {
        if (active.current === scope)
          setError("Provider models could not be loaded.");
        throw new Error("Provider models could not be loaded.");
      } finally {
        if (active.current === scope)
          setLoading((current) => ({ ...current, [providerId]: false }));
      }
    },
    [requireScope, assertCurrent],
  );

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
      let saved = false;
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
        assertCurrent(scope);
        const receipt = await window.desktop.credential({
          operation: "status",
          providerId,
        });
        assertCurrent(scope);
        if (
          Array.isArray(receipt) ||
          !("status" in receipt) ||
          receipt.status !== "present"
        )
          throw new Error(
            "Protected credential storage did not confirm the save.",
          );
        setCredentials((current) => [
          ...current.filter((item) => item.providerId !== providerId),
          { providerId, status: receipt.status },
        ]);
        const discovered = await loadModels(providerId);
        assertCurrent(scope);
        const first = discovered.find(
          (model) => model.availability !== "unsupported_transport",
        );
        if (first) {
          const selected = await scope.client.selectProvider(
            providerId,
            first.id,
          );
          assertCurrent(scope);
          setSelection(selected);
        }
        setError(null);
      } catch {
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
      try {
        await window.desktop.credential({ operation: "delete", providerId });
        assertCurrent(scope);
        setCredentials((current) =>
          current.filter((item) => item.providerId !== providerId),
        );
        setModels((current) => {
          const next = { ...current };
          delete next[providerId];
          return next;
        });
        if (selection?.providerId === providerId) {
          await scope.client.clearProviderSelection();
          assertCurrent(scope);
          setSelection(null);
        }
        setError(null);
      } catch {
        if (active.current === scope)
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
      void scope.client
        .updateProviderPreferences(undefined, { visibleModelIds }, scope.grant)
        .then((value) => {
          assertCurrent(scope);
          setPreferences(value);
        })
        .catch(() => {
          if (active.current === scope)
            setError(
              "Model visibility could not be saved. Restore workspace access and retry.",
            );
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
          models[providerId]?.map((model) => model.id) ??
          [],
      );
      if (current.has(modelId)) current.delete(modelId);
      else current.add(modelId);
      saveVisibility(providerId, [...current]);
    },
    [preferences, models, saveVisibility],
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

  return {
    status: error ? "error" : status,
    error,
    catalog,
    credentials,
    providerModels: models,
    manageProviderModels: models,
    visibleModelIds,
    loadingModelsForProviderId:
      Object.keys(loading).find((providerId) => loading[providerId]) ?? null,
    loadingManageModelsForProviderIds: loading,
    preferences,
    selectedProviderId: selection?.providerId ?? null,
    selectedCredentialId: null,
    selectedModelId: selection?.modelId ?? null,
    connectCredential,
    disconnectCredential,
    applySessionSelection,
    loadProviderModels: loadModels,
    loadManageProviderModels: loadModels,
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
