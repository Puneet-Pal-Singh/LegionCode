import { ModelPickerPopover } from "@legioncode/client-ui";
import { createProviderProductPolicy } from "@repo/shared-types";
import type { useDesktopHostedProviderSettings } from "./useDesktopHostedProviderSettings";

const policy = createProviderProductPolicy("production");

export function DesktopHostedModelPicker({ controls, disabled = false, onConnectProvider, onManageModels }: {
  controls: ReturnType<typeof useDesktopHostedProviderSettings>;
  disabled?: boolean;
  onConnectProvider: () => void;
  onManageModels: () => void;
}) {
  const { provider, picker } = controls;
  const selected = provider.selectedProviderId;
  return <ModelPickerPopover
    policy={policy}
    catalog={provider.catalog}
    credentials={provider.credentials}
    providerModels={provider.providerModels}
    visibleModelIds={provider.visibleModelIds}
    selectedProviderId={selected}
    selectedModelId={provider.selectedModelId}
    selectedProviderMetadata={selected ? picker.pages[selected]?.metadata : null}
    hasMoreSelectedProviderModels={selected ? picker.pages[selected]?.page.hasMore : false}
    isLoadingMoreSelectedProviderModels={selected ? picker.loadingModels[selected] : false}
    onSelectModel={controls.selectModel}
    onLoadMoreSelectedProviderModels={picker.loadMore}
    onEnsureSelectedProviderModels={picker.ensureModels}
    onRefreshSelectedProviderModels={picker.refreshModels}
    onConnectProvider={onConnectProvider}
    onManageModels={onManageModels}
    isLoading={provider.status === "loading"}
    disabled={disabled || provider.status !== "ready"}
  />;
}
