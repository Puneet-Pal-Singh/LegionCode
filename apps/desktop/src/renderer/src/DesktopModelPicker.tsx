import {
  ModelPickerPopover,
  type ModelPickerModel,
} from "@legioncode/client-ui";
import type { WorkspaceId } from "@repo/platform-protocol";
import type { AppServerClient } from "@legioncode/sdk";
import {
  createProviderProductPolicy,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type DesktopModelPickerClient = Pick<
  AppServerClient,
  | "getWorkspaceGrant"
  | "readProviderPreferences"
  | "getProviderCatalog"
  | "getProviderModels"
  | "getProviderSelection"
  | "selectProvider"
>;
type Selection = Awaited<ReturnType<AppServerClient["getProviderSelection"]>>;
type Scope = {
  client: DesktopModelPickerClient;
  revision: number;
  workspaceId: WorkspaceId;
};
type PickerRead = {
  scope: Scope;
  catalog: ProviderRegistryEntry[];
  credentials: Array<{ providerId: string }>;
  models: Record<string, ModelPickerModel[]>;
  selection: Selection;
  visibleModelIds: Record<string, Set<string>>;
  error: string | null;
};

// The local provider service exposes supported API-key routes, without Axis fallback.
const DESKTOP_PROVIDER_POLICY = createProviderProductPolicy("production");

/** Local SDK routing plus protected credential-status metadata; no provider secrets or hosted state. */
export function useDesktopModelPicker(
  client: DesktopModelPickerClient,
  revision: number,
  workspaceId: WorkspaceId,
) {
  const scope = useMemo(
    () => ({ client, revision, workspaceId }),
    [client, revision, workspaceId],
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
    void Promise.all([
      client.getProviderCatalog(),
      client.getProviderSelection(),
      window.desktop.credential({ operation: "list" }),
      client.getWorkspaceGrant().then((grant) => {
        if (
          !grant ||
          grant.readiness !== "ready" ||
          grant.workspaceId !== workspaceId
        )
          throw new Error("Workspace scope changed");
        return client.readProviderPreferences(undefined, {
          workspaceId,
          grantedAt: grant.grantedAt,
        });
      }),
    ])
      .then(async ([catalog, selection, statuses, preferences]) => {
        if (!Array.isArray(statuses))
          throw new Error("Credential status metadata is unavailable");
        const credentials = statuses
          .filter(
            (status) =>
              status.status === "present" &&
              catalog.some(
                (provider) => provider.providerId === status.providerId,
              ),
          )
          .map(({ providerId }) => ({ providerId }));
        const pages = await Promise.all(
          credentials.map(async ({ providerId }) => {
            const page = await client.getProviderModels(providerId);
            return [providerId, page.models] as const;
          }),
        );
        if (active && activeScope.current === scope) {
          setRead({
            scope,
            catalog,
            credentials,
            models: Object.fromEntries(pages),
            selection,
            visibleModelIds: Object.fromEntries(
              Object.entries(preferences.visibleModelIds).map(
                ([providerId, ids]) => [providerId, new Set(ids)],
              ),
            ),
            error: null,
          });
        }
      })
      .catch(() => {
        if (active && activeScope.current === scope)
          setRead({
            scope,
            catalog: [],
            credentials: [],
            models: {},
            selection: null,
            visibleModelIds: {},
            error:
              "Provider models could not be loaded. Open provider setup to retry.",
          });
      });
    return () => {
      active = false;
    };
  }, [client, scope]);

  const current = read?.scope === scope ? read : null;
  const selectModel = async (
    providerId: string,
    modelId: string,
  ): Promise<void> => {
    if (!current || activeScope.current !== scope || saving) return;
    if (
      !current.credentials.some(
        (credential) => credential.providerId === providerId,
      )
    ) {
      throw new Error("Connect this provider before selecting a model.");
    }
    setSelectionError(null);
    setSaving(true);
    try {
      const selection = await client.selectProvider(providerId, modelId);
      if (activeScope.current !== scope) return;
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
  const unavailableReason = !current
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
            : undefined));

  return {
    current,
    selection: current?.selection ?? null,
    selectModel,
    unavailableReason,
    error: selectionError ?? current?.error ?? null,
  };
}

export function DesktopModelPicker({
  controls,
  onConnectProvider,
  onManageModels,
  onModelSwitchWarning,
}: {
  controls: ReturnType<typeof useDesktopModelPicker>;
  onConnectProvider: () => void;
  onManageModels: () => void;
  onModelSwitchWarning?: () => void;
}) {
  const { current, selection } = controls;
  return (
    <ModelPickerPopover
      policy={DESKTOP_PROVIDER_POLICY}
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
      onConnectProvider={onConnectProvider}
      onManageModels={onManageModels}
      isLoading={!current}
    />
  );
}
