import { useEffect, useMemo, useState } from "react";
import type { ProviderId } from "@repo/shared-types";
import {
  AXIS_PROVIDER_ID,
  canShowProviderInPrimaryUi,
} from "@repo/shared-types";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { findCredentialByProviderId } from "../../lib/provider-helpers.js";
import { ProviderDialog, ModelPickerPopover } from "../provider/index.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";
import {
  isProviderModelBootstrapLoading,
  isProviderVisibleModelHydrationPending,
} from "../../lib/provider-model-bootstrap-loading.js";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

export function useWebComposerProviderControls({
  runId,
  onModelSelect,
  hasMessages = false,
  isComposerActiveRun,
}: {
  runId?: string;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
  hasMessages?: boolean;
  isComposerActiveRun: boolean;
}) {
  const [showProviderDialog, setShowProviderDialog] = useState(false);
  const [providerDialogInitialTab, setProviderDialogInitialTab] = useState<
    "connected" | "available" | "preferences" | "session" | undefined
  >(undefined);
  const [providerDialogInitialView, setProviderDialogInitialView] = useState<
    "default" | "manage-models"
  >("default");
  const [providerDialogVariant, setProviderDialogVariant] = useState<
    "full" | "connect-only" | "manage-models-only"
  >("full");
  const {
    catalog,
    credentials,
    status,
    selectedProviderId,
    selectedModelId,
    axisQuota,
    selectedModelView,
    lastResolvedConfig,
    providerModels,
    manageProviderModels,
    providerModelsMetadata,
    providerModelsPage,
    visibleModelIds,
    loadingModelsForProviderId,
    loadingManageModelsForProviderIds,
    refreshingModelsForProviderId,
    loadManageProviderModels,
    loadMoreProviderModels,
    ensureProviderModelsFresh,
    refreshProviderModels,
    setModelView,
    applySessionSelection,
  } = useProviderStore(runId);
  const isModelPickerLoading = useMemo(
    () =>
      isProviderModelBootstrapLoading({
        status,
        providerModels,
        selectedProviderId,
      }),
    [status, providerModels, selectedProviderId],
  );
  const isSelectedProviderModelHydrationPending = useMemo(
    () =>
      isProviderVisibleModelHydrationPending({
        selectedProviderId,
        providerModels,
        visibleModelIds,
        manageProviderModels: manageProviderModels ?? {},
      }),
    [manageProviderModels, providerModels, selectedProviderId, visibleModelIds],
  );
  const selectedModel = selectedProviderId
    ? (providerModels[selectedProviderId]?.find(
        (model) => model.id === selectedModelId,
      ) ??
      manageProviderModels?.[selectedProviderId]?.find(
        (model) => model.id === selectedModelId,
      ))
    : undefined;
  useEffect(() => {
    if (!onModelSelect || !lastResolvedConfig) {
      return;
    }
    onModelSelect(lastResolvedConfig.providerId, lastResolvedConfig.modelId);
  }, [lastResolvedConfig, onModelSelect]);

  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    void ensureProviderModelsFresh(selectedProviderId);
  }, [ensureProviderModelsFresh, selectedProviderId]);

  useEffect(() => {
    if (!selectedProviderId || !isSelectedProviderModelHydrationPending) {
      return;
    }
    if (loadingManageModelsForProviderIds?.[selectedProviderId]) {
      return;
    }
    if (!loadManageProviderModels) {
      return;
    }

    void loadManageProviderModels(selectedProviderId).catch((error) => {
      console.warn(
        "[chat-input/model-picker] failed to hydrate selected visible models",
        error,
      );
    });
  }, [
    isSelectedProviderModelHydrationPending,
    loadManageProviderModels,
    loadingManageModelsForProviderIds,
    selectedProviderId,
  ]);

  return {
    renderModelPicker: (onModelSwitchWarning: () => void) => (
      <>
        <ModelPickerPopover
          catalog={catalog}
          credentials={credentials}
          providerModels={providerModels}
          visibleModelIds={visibleModelIds}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          selectedModelView={selectedModelView}
          selectedProviderMetadata={
            selectedProviderId
              ? (providerModelsMetadata[selectedProviderId] ?? null)
              : null
          }
          hasMoreSelectedProviderModels={
            selectedProviderId
              ? (providerModelsPage[selectedProviderId]?.hasMore ?? false)
              : false
          }
          isLoadingMoreSelectedProviderModels={
            selectedProviderId !== null &&
            loadingModelsForProviderId === selectedProviderId
          }
          isRefreshingSelectedProviderModels={
            selectedProviderId !== null &&
            refreshingModelsForProviderId === selectedProviderId
          }
          onSelectModel={async (providerId, modelId) => {
            // Model selection is scoped to the next turn. The current
            // run was already admitted with its own model and must not
            // be interrupted or rewritten when the picker changes.
            const credential = findCredentialByProviderId(
              credentials,
              providerId,
            );
            if (!credential) {
              setProviderDialogInitialTab("available");
              setProviderDialogInitialView("default");
              setProviderDialogVariant("connect-only");
              setShowProviderDialog(true);
              return;
            }
            if (hasMessages && !isComposerActiveRun) {
              onModelSwitchWarning();
            }
            await applySessionSelection({
              providerId,
              credentialId: credential.credentialId,
              modelId,
            });
          }}
          onSelectModelView={setModelView}
          onLoadMoreSelectedProviderModels={loadMoreProviderModels}
          onEnsureSelectedProviderModels={(providerId) =>
            ensureProviderModelsFresh(providerId)
          }
          onRefreshSelectedProviderModels={refreshProviderModels}
          onConnectProvider={() => {
            setProviderDialogInitialTab("available");
            setProviderDialogInitialView("default");
            setProviderDialogVariant("connect-only");
            setShowProviderDialog(true);
          }}
          onManageModels={() => {
            setProviderDialogInitialTab("connected");
            setProviderDialogInitialView("manage-models");
            setProviderDialogVariant("manage-models-only");
            setShowProviderDialog(true);
          }}
          isLoading={isModelPickerLoading}
          isHydratingVisibleModels={isSelectedProviderModelHydrationPending}
        />

        {selectedProviderId &&
        selectedModelId &&
        selectedModel?.capabilities?.reasoningEfforts?.length ? (
          <ReasoningEffortPicker
            providerId={selectedProviderId}
            modelId={selectedModelId}
            efforts={selectedModel.capabilities.reasoningEfforts}
            disabled={isComposerActiveRun}
          />
        ) : null}
      </>
    ),
    providerNotice:
      WEB_PROVIDER_POLICY.isByokFirstProduction && credentials.length === 0 ? (
        <div className="ui-control-surface mt-3 px-3 py-2 text-xs text-zinc-300">
          Connect a BYOK provider to pick a model before sending prompts.
          <button
            type="button"
            onClick={() => {
              setProviderDialogInitialTab("available");
              setProviderDialogInitialView("default");
              setProviderDialogVariant("connect-only");
              setShowProviderDialog(true);
            }}
            className="ml-1 text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
          >
            Open provider setup
          </button>
          .
        </div>
      ) : null,
    providerQuota:
      selectedProviderId === AXIS_PROVIDER_ID &&
      axisQuota &&
      canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, AXIS_PROVIDER_ID) ? (
        <span
          className="rounded border border-emerald-800/60 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
          title={`Axis daily usage resets at ${new Date(axisQuota.resetsAt).toLocaleString()}`}
        >
          Axis {axisQuota.used}/{axisQuota.limit}
        </span>
      ) : null,
    providerDialog: (
      <ProviderDialog
        isOpen={showProviderDialog}
        onClose={() => {
          setShowProviderDialog(false);
          setProviderDialogInitialTab(undefined);
          setProviderDialogInitialView("default");
          setProviderDialogVariant("full");
        }}
        mode="composer"
        initialTab={providerDialogInitialTab}
        initialView={providerDialogInitialView}
        variant={providerDialogVariant}
      />
    ),
  };
}
