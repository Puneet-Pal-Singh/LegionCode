/**
 * Model Picker Popover - Composer Integration
 *
 * Lightweight popover for selecting provider/model from chat composer.
 * Groups models by provider, supports search, and provides quick actions.
 *
 * Features:
 * - Provider-grouped model list with search
 * - Selected model indicator (checkmark)
 * - Compact quick actions beside search (Connect, Manage Models)
 * - Deterministic run-scoped selection via ProviderStore
 */

import React, { useMemo, useState, useRef, useEffect } from "react";
import { ChevronDown, Search, Plus, Settings, RefreshCw } from "lucide-react";
import {
  AXIS_PROVIDER_ID,
  BYOKCredential as ProviderCredential,
  canShowProviderInPrimaryUi,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import {
  type ProviderModelDiscoveryView,
  type ProviderModelOption,
  type ProviderModelsMetadata,
} from "../../services/api/providerClient.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";
import { isProviderModelAvailable } from "./providerModelAvailability";

const VIEWPORT_PADDING_PX = 12;
const POPOVER_GAP_PX = 8;
const ESTIMATED_POPOVER_HEIGHT_PX = 360;
const PREFERRED_POPOVER_WIDTH_PX = 304;
const MIN_POPOVER_WIDTH_PX = 248;
const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

interface PopoverPlacement {
  vertical: "up" | "down";
  horizontal: "start" | "end";
  widthPx: number;
}

function isSamePlacement(
  first: PopoverPlacement,
  second: PopoverPlacement,
): boolean {
  return (
    first.vertical === second.vertical &&
    first.horizontal === second.horizontal &&
    first.widthPx === second.widthPx
  );
}

/**
 * Props for ModelPickerPopover
 */
export interface ModelPickerPopoverProps {
  catalog: ProviderRegistryEntry[];
  credentials: ProviderCredential[];
  providerModels: Record<string, ProviderModelOption[]>;
  visibleModelIds: Record<string, Set<string>>;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedModelView?: ProviderModelDiscoveryView;
  selectedProviderMetadata?: ProviderModelsMetadata | null;
  hasMoreSelectedProviderModels?: boolean;
  isLoadingMoreSelectedProviderModels?: boolean;
  isRefreshingSelectedProviderModels?: boolean;
  onSelectModel: (providerId: string, modelId: string) => Promise<void>;
  onSelectModelView?: (view: ProviderModelDiscoveryView) => Promise<void>;
  onLoadMoreSelectedProviderModels?: (
    providerId: string,
  ) => Promise<ProviderModelOption[]>;
  onRefreshSelectedProviderModels?: (providerId: string) => Promise<void>;
  onConnectProvider: () => void;
  onManageModels: () => void;
  isLoading?: boolean;
  isHydratingVisibleModels?: boolean;
}

/**
 * Internal representation of a grouped provider + models
 */
interface ProviderGroup {
  providerId: string;
  displayName: string;
  models: ProviderModelOption[];
  isConnected: boolean;
  isModelListLoaded: boolean;
}

interface FilteredProviderGroup extends ProviderGroup {
  hasModelsHiddenByVisibility: boolean;
}

interface EffectiveSelection {
  providerId: string | null;
  modelId: string | null;
}

function formatProviderDisplayName(
  providerId: string,
  displayName: string,
): string {
  return providerId === AXIS_PROVIDER_ID ? "Axis (Free)" : displayName;
}

function getViewLabel(
  view: ProviderModelDiscoveryView,
  providerId: string | null,
): string {
  if (view === "popular") {
    return providerId === "openrouter" ? "Recommended" : "Popular";
  }
  return "All";
}

function resolveEffectiveSelection(
  catalog: ProviderRegistryEntry[],
  providerModels: Record<string, ProviderModelOption[]>,
  selectedProviderId: string | null,
  selectedModelId: string | null,
): EffectiveSelection {
  if (selectedProviderId && selectedModelId) {
    if (
      isValidExplicitSelection(
        providerModels,
        selectedProviderId,
        selectedModelId,
      )
    ) {
      return { providerId: selectedProviderId, modelId: selectedModelId };
    }
    if (
      shouldPreservePendingSelection(
        providerModels,
        selectedProviderId,
        selectedModelId,
      ) &&
      hasProvider(catalog, selectedProviderId)
    ) {
      return { providerId: selectedProviderId, modelId: selectedModelId };
    }
    return resolveAxisDefaultSelection(catalog, providerModels);
  }

  if (
    isValidExplicitSelection(
      providerModels,
      selectedProviderId,
      selectedModelId,
    )
  ) {
    return { providerId: selectedProviderId, modelId: selectedModelId };
  }

  if (selectedProviderId && hasProvider(catalog, selectedProviderId)) {
    return {
      providerId: selectedProviderId,
      modelId: null,
    };
  }

  return resolveAxisDefaultSelection(catalog, providerModels);
}

function isValidExplicitSelection(
  providerModels: Record<string, ProviderModelOption[]>,
  selectedProviderId: string | null,
  selectedModelId: string | null,
): boolean {
  if (!selectedProviderId || !selectedModelId) {
    return false;
  }
  const models = providerModels[selectedProviderId] ?? [];
  return models.some((model) => model.id === selectedModelId);
}

function shouldPreservePendingSelection(
  providerModels: Record<string, ProviderModelOption[]>,
  selectedProviderId: string,
  selectedModelId: string,
): boolean {
  if (!selectedProviderId || !selectedModelId) {
    return false;
  }

  if (
    !Object.prototype.hasOwnProperty.call(providerModels, selectedProviderId)
  ) {
    return true;
  }

  return !(providerModels[selectedProviderId] ?? []).some(
    (model) => model.id === selectedModelId,
  );
}

function hasProvider(
  catalog: ProviderRegistryEntry[],
  providerId: string,
): boolean {
  return catalog.some((entry) => entry.providerId === providerId);
}

function resolveAxisDefaultSelection(
  catalog: ProviderRegistryEntry[],
  providerModels: Record<string, ProviderModelOption[]>,
): EffectiveSelection {
  if (!canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, AXIS_PROVIDER_ID)) {
    return { providerId: null, modelId: null };
  }

  const axisProvider = catalog.find(
    (entry) => entry.providerId === AXIS_PROVIDER_ID,
  );
  const axisModels = providerModels[AXIS_PROVIDER_ID] ?? [];
  if (!axisProvider || axisModels.length === 0) {
    return { providerId: null, modelId: null };
  }

  const defaultModelId = axisProvider.defaultModelId ?? axisModels[0]?.id;
  if (!defaultModelId) {
    return { providerId: null, modelId: null };
  }
  const matchedModel = axisModels.find((model) => model.id === defaultModelId);
  const effectiveModelId = matchedModel?.id ?? axisModels[0]?.id ?? null;
  if (!effectiveModelId) {
    return { providerId: null, modelId: null };
  }
  return {
    providerId: AXIS_PROVIDER_ID,
    modelId: effectiveModelId,
  };
}

function buildConnectedProviderIds(
  credentials: ProviderCredential[],
): Set<string> {
  return new Set(credentials.map((credential) => credential.providerId));
}

/**
 * ModelPickerPopover Component
 */
export function ModelPickerPopover({
  catalog,
  credentials,
  providerModels,
  visibleModelIds,
  selectedProviderId,
  selectedModelId,
  selectedModelView = "popular",
  hasMoreSelectedProviderModels = false,
  isLoadingMoreSelectedProviderModels = false,
  isRefreshingSelectedProviderModels = false,
  onSelectModel,
  onSelectModelView,
  onLoadMoreSelectedProviderModels,
  onRefreshSelectedProviderModels,
  onConnectProvider,
  onManageModels,
  isLoading = false,
  isHydratingVisibleModels = false,
}: ModelPickerPopoverProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement>({
    vertical: "down",
    horizontal: "start",
    widthPx: PREFERRED_POPOVER_WIDTH_PX,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectingModelId, setSelectingModelId] = useState<string | null>(null);
  const [isSwitchingView, setIsSwitchingView] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const connectedProviderIds = useMemo(
    () => buildConnectedProviderIds(credentials),
    [credentials],
  );
  const effectiveSelection = useMemo(
    () =>
      resolveEffectiveSelection(
        catalog,
        providerModels,
        selectedProviderId,
        selectedModelId,
      ),
    [catalog, providerModels, selectedProviderId, selectedModelId],
  );

  // Build provider groups from catalog and models
  const providerGroups = useMemo((): ProviderGroup[] => {
    return catalog
      .filter((entry) => {
        if (
          !canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, entry.providerId)
        ) {
          return false;
        }

        if (entry.providerId === AXIS_PROVIDER_ID) {
          return true;
        }

        return (
          connectedProviderIds.has(entry.providerId) ||
          (providerModels[entry.providerId]?.length ?? 0) > 0
        );
      })
      .map((entry) => ({
        providerId: entry.providerId,
        displayName: formatProviderDisplayName(
          entry.providerId,
          entry.displayName,
        ),
        models: providerModels[entry.providerId] || [],
        isConnected:
          entry.providerId === "axis" ||
          connectedProviderIds.has(entry.providerId),
        isModelListLoaded: Object.prototype.hasOwnProperty.call(
          providerModels,
          entry.providerId,
        ),
      }))
      .filter(
        (group) =>
          group.providerId === AXIS_PROVIDER_ID ||
          group.isConnected ||
          group.models.length > 0,
      );
  }, [catalog, connectedProviderIds, providerModels]);

  // Filter groups and models based on search and visibility
  const filteredGroups = useMemo((): FilteredProviderGroup[] => {
    const query = searchQuery.toLowerCase();
    const byVisibility = providerGroups.map((group) => {
      const visibleSet = visibleModelIds[group.providerId];
      const visibleModels = visibleSet
        ? group.models.filter((model) => visibleSet.has(model.id))
        : group.models;

      return {
        ...group,
        models: visibleModels,
        hasModelsHiddenByVisibility:
          group.models.length > 0 && visibleModels.length === 0,
      };
    });

    if (!query.trim()) {
      return byVisibility.filter(
        (group) =>
          group.models.length > 0 ||
          (group.isConnected && !group.hasModelsHiddenByVisibility),
      );
    }

    return byVisibility
      .map((group) => ({
        ...group,
        models: group.displayName.toLowerCase().includes(query)
          ? group.models
          : group.models.filter(
              (model) =>
                model.name.toLowerCase().includes(query) ||
                model.id.toLowerCase().includes(query),
            ),
      }))
      .filter(
        (group) =>
          group.models.length > 0 ||
          (group.isConnected &&
            !group.hasModelsHiddenByVisibility &&
            group.displayName.toLowerCase().includes(query)),
      );
  }, [providerGroups, searchQuery, visibleModelIds]);
  const axisDefaultGroup = filteredGroups.find(
    (group) => group.providerId === AXIS_PROVIDER_ID,
  );
  const connectedProviderGroups = filteredGroups.filter(
    (group) => group.providerId !== AXIS_PROVIDER_ID,
  );

  // Get currently selected model label
  const selectedModelLabel = useMemo((): string => {
    if (!effectiveSelection.providerId || !effectiveSelection.modelId) {
      return WEB_PROVIDER_POLICY.isByokFirstProduction &&
        connectedProviderIds.size === 0
        ? "Connect Provider"
        : "Select Model";
    }

    const provider = catalog.find(
      (p) => p.providerId === effectiveSelection.providerId,
    );
    const model = providerModels[effectiveSelection.providerId]?.find(
      (m) => m.id === effectiveSelection.modelId,
    );

    if (!provider) {
      return "Select Model";
    }

    if (!model && effectiveSelection.modelId) {
      return `${formatProviderDisplayName(provider.providerId, provider.displayName)}: ${effectiveSelection.modelId}`;
    }

    if (!model) {
      return "Select Model";
    }

    return `${formatProviderDisplayName(provider.providerId, provider.displayName)}: ${model.name}`;
  }, [connectedProviderIds, effectiveSelection, catalog, providerModels]);
  const modelLoadingLabel = isHydratingVisibleModels
    ? "Loading selected models..."
    : "Loading models...";
  const triggerLabel = isLoading ? modelLoadingLabel : selectedModelLabel;

  // Handle model selection
  const handleSelectModel = async (
    providerId: string,
    modelId: string,
  ): Promise<void> => {
    setSelectingModelId(modelId);
    setIsOpen(false);
    setSearchQuery("");
    try {
      await onSelectModel(providerId, modelId);
    } catch (error) {
      console.error(
        "[model-picker/select] Failed to persist model selection:",
        error,
      );
    } finally {
      setSelectingModelId(null);
    }
  };

  const handleModelViewChange = async (
    nextView: ProviderModelDiscoveryView,
  ): Promise<void> => {
    if (
      !onSelectModelView ||
      nextView === selectedModelView ||
      isSwitchingView
    ) {
      return;
    }
    setIsSwitchingView(true);
    try {
      await onSelectModelView(nextView);
    } catch (error) {
      console.error(
        "[model-picker/view-change] Failed to switch model view:",
        error,
      );
    } finally {
      setIsSwitchingView(false);
    }
  };

  const handleLoadMore = async (): Promise<void> => {
    const providerId = effectiveSelection.providerId ?? selectedProviderId;
    if (!providerId || !onLoadMoreSelectedProviderModels) {
      return;
    }
    try {
      await onLoadMoreSelectedProviderModels(providerId);
    } catch (error) {
      console.error(
        "[model-picker/load-more] Failed to load more models:",
        error,
      );
    }
  };

  const handleRefresh = async (): Promise<void> => {
    const providerId = effectiveSelection.providerId ?? selectedProviderId;
    if (!providerId || !onRefreshSelectedProviderModels) {
      return;
    }
    try {
      await onRefreshSelectedProviderModels(providerId);
    } catch (error) {
      console.error("[model-picker/refresh] Failed to refresh models:", error);
    }
  };

  const canSelectModelView = Boolean(onSelectModelView);
  const canRefreshSelectedProviderModels = Boolean(
    onRefreshSelectedProviderModels,
  );
  const canLoadMoreSelectedProviderModels = Boolean(
    onLoadMoreSelectedProviderModels,
  );
  const isLoadingModelsInline =
    !isLoading &&
    (isLoadingMoreSelectedProviderModels ||
      isRefreshingSelectedProviderModels ||
      isHydratingVisibleModels);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Focus search input when popover opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const resolvePlacement = (): PopoverPlacement => {
    const triggerRect = triggerButtonRef.current?.getBoundingClientRect();
    if (!triggerRect) {
      return {
        vertical: "down",
        horizontal: "start",
        widthPx: PREFERRED_POPOVER_WIDTH_PX,
      };
    }

    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const requiredHeight = ESTIMATED_POPOVER_HEIGHT_PX + POPOVER_GAP_PX;
    const vertical: "up" | "down" =
      spaceBelow < requiredHeight && spaceAbove > spaceBelow ? "up" : "down";

    const spaceRight =
      window.innerWidth - triggerRect.left - VIEWPORT_PADDING_PX;
    const spaceLeft = triggerRect.right - VIEWPORT_PADDING_PX;
    const horizontal: "start" | "end" =
      spaceRight < PREFERRED_POPOVER_WIDTH_PX && spaceLeft > spaceRight
        ? "end"
        : "start";

    const availableWidth = horizontal === "start" ? spaceRight : spaceLeft;
    const widthPx = Math.max(
      MIN_POPOVER_WIDTH_PX,
      Math.min(PREFERRED_POPOVER_WIDTH_PX, Math.floor(availableWidth)),
    );

    return {
      vertical,
      horizontal,
      widthPx,
    };
  };

  const handleToggle = (): void => {
    if (!isOpen) {
      setPlacement(resolvePlacement());
    }
    setIsOpen((current) => !current);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleViewportChange = (): void => {
      const nextPlacement = resolvePlacement();
      setPlacement((currentPlacement) =>
        isSamePlacement(currentPlacement, nextPlacement)
          ? currentPlacement
          : nextPlacement,
      );
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen]);

  return (
    <div ref={popoverRef} className="relative">
      {/* Trigger Button */}
      <button
        ref={triggerButtonRef}
        type="button"
        onClick={handleToggle}
        className={`
          inline-flex h-7 max-w-[min(16rem,calc(100vw-6rem))] items-center gap-1.5 rounded-md
          bg-transparent px-2 text-xs font-medium text-neutral-400
          transition-colors hover:bg-neutral-800/50 hover:text-neutral-200
          focus:outline-none focus:ring-2 focus:ring-blue-500
        `}
        aria-label="Open model picker"
        aria-expanded={isOpen}
        title={triggerLabel}
      >
        <span className="truncate max-w-[13rem]">{triggerLabel}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Popover Content */}
      {isOpen && (
        <div
          data-testid="model-picker-popover"
          className={`
            absolute z-50 flex max-h-[18rem] flex-col overflow-hidden rounded-xl
            border border-neutral-700/80 bg-neutral-900/95 shadow-2xl backdrop-blur
            ${placement.vertical === "down" ? "top-full mt-2" : "bottom-full mb-2"}
            ${placement.horizontal === "start" ? "left-0" : "right-0"}
          `}
          style={{
            width: `${placement.widthPx}px`,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING_PX * 2}px)`,
          }}
        >
          {!isLoading && (
            <>
              {/* Search + Actions */}
              <div className="flex items-center gap-1.5 border-b border-neutral-800 p-1.5">
                <div className="relative flex-1">
                  <Search
                    size={14}
                    className="absolute left-2.5 top-2.5 text-neutral-500"
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Search models or providers..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={`
                      h-8 w-full rounded-md
                      bg-neutral-800 border border-neutral-700
                      pl-8 pr-3 text-xs text-neutral-100 placeholder-neutral-500
                      focus:outline-none focus:ring-2 focus:ring-blue-500
                    `}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    onConnectProvider();
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-700 text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
                  aria-label="Connect provider"
                  title="Connect provider"
                >
                  <Plus size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    onManageModels();
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-700 text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
                  aria-label="Manage model visibility"
                  title="Manage model visibility"
                >
                  <Settings size={12} />
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-2 py-1.5">
                <div className="inline-flex rounded-md border border-neutral-700 p-0.5">
                  {(["popular", "all"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => {
                        void handleModelViewChange(view);
                      }}
                      disabled={
                        !canSelectModelView || isSwitchingView || isLoading
                      }
                      className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                        selectedModelView === view
                          ? "bg-neutral-200 text-neutral-900"
                          : "text-neutral-300 hover:bg-neutral-800"
                      }`}
                    >
                      {getViewLabel(view, selectedProviderId)}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void handleRefresh();
                    }}
                    disabled={
                      !canRefreshSelectedProviderModels ||
                      !(effectiveSelection.providerId ?? selectedProviderId) ||
                      isRefreshingSelectedProviderModels ||
                      isLoading
                    }
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-700 px-2 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                  >
                    <RefreshCw
                      size={11}
                      className={
                        isRefreshingSelectedProviderModels ? "animate-spin" : ""
                      }
                    />
                    Refresh
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Provider Groups */}
          <div
            className={`flex flex-1 flex-col overflow-hidden ${
              isLoading ? "min-h-[12rem]" : ""
            }`}
          >
            {isLoadingModelsInline && (
              <div
                role="status"
                aria-live="polite"
                className="border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400"
              >
                {modelLoadingLabel}
              </div>
            )}
            <div
              className={`overflow-y-auto flex-1 ${
                isLoading ? "flex items-center justify-center" : ""
              }`}
            >
              {isLoading ? (
                <div className="px-6 py-8 text-center">
                  <p className="text-sm font-medium text-neutral-200">
                    {modelLoadingLabel}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Fetching available models from your providers.
                  </p>
                </div>
              ) : filteredGroups.length === 0 ? (
                <div className="p-6 text-center text-neutral-400 text-sm">
                  {searchQuery
                    ? "No models match your search"
                    : WEB_PROVIDER_POLICY.isByokFirstProduction &&
                        connectedProviderIds.size === 0
                      ? "Connect a BYOK provider to choose models."
                      : "No models available yet."}
                </div>
              ) : (
                <>
                  {axisDefaultGroup && (
                    <div className="border-b border-neutral-800/80">
                      <div className="sticky top-0 bg-neutral-900/95 px-3 py-2">
                        <h3 className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">
                          LegionCode Axis
                        </h3>
                      </div>
                      <div className="py-1">
                        {axisDefaultGroup.models.map((model) => (
                          <button
                            type="button"
                            key={model.id}
                            onClick={() =>
                              handleSelectModel(
                                axisDefaultGroup.providerId,
                                model.id,
                              )
                            }
                            disabled={selectingModelId === model.id}
                            className={`
                            w-full px-3 py-2 text-left text-xs
                            transition-colors disabled:opacity-50
                            ${
                              effectiveSelection.providerId ===
                                axisDefaultGroup.providerId &&
                              effectiveSelection.modelId === model.id
                                ? "bg-neutral-800 text-neutral-100"
                                : "text-neutral-400 hover:bg-neutral-800/50"
                            }
                          `}
                            title={`${model.name} (${model.id})`}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <p className="truncate font-medium">
                                {model.name}
                              </p>
                              {effectiveSelection.providerId ===
                                axisDefaultGroup.providerId &&
                                effectiveSelection.modelId === model.id && (
                                  <span className="ml-auto text-neutral-200">
                                    ✓
                                  </span>
                                )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {connectedProviderGroups.length > 0 &&
                    connectedProviderGroups.map((group) => (
                      <div
                        key={group.providerId}
                        className="border-b border-neutral-800/80 last:border-b-0"
                      >
                        <div className="sticky top-0 bg-neutral-900/95 px-3 py-2">
                          <h3 className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">
                            {group.displayName}
                          </h3>
                        </div>
                        <div className="py-1">
                          {effectiveSelection.providerId === group.providerId &&
                            effectiveSelection.modelId !== null &&
                            !providerModels[group.providerId]?.some(
                              (model) =>
                                model.id === effectiveSelection.modelId,
                            ) && (
                              <div
                                className="px-3 py-2 text-left text-xs bg-neutral-800 text-neutral-100"
                                title={effectiveSelection.modelId}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <p className="truncate font-medium">
                                    {effectiveSelection.modelId}
                                  </p>
                                </div>
                              </div>
                            )}
                          {group.models.map((model) => (
                            <button
                              type="button"
                              key={model.id}
                              onClick={() => {
                                if (!isProviderModelAvailable(model)) {
                                  return;
                                }
                                handleSelectModel(group.providerId, model.id);
                              }}
                              disabled={
                                selectingModelId === model.id ||
                                !isProviderModelAvailable(model)
                              }
                              className={`
                              w-full px-3 py-2 text-left text-xs
                              transition-colors disabled:opacity-50
                              ${
                                effectiveSelection.providerId ===
                                  group.providerId &&
                                effectiveSelection.modelId === model.id
                                  ? "bg-neutral-800 text-neutral-100"
                                  : "text-neutral-400 hover:bg-neutral-800/50"
                              }
                            `}
                              title={`${model.name} (${model.id})`}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <p className="truncate font-medium">
                                  {model.name}
                                </p>
                                {!isProviderModelAvailable(model) && (
                                  <span className="ml-auto text-[10px] uppercase tracking-wide text-amber-300">
                                    Unavailable
                                  </span>
                                )}
                                {effectiveSelection.providerId ===
                                  group.providerId &&
                                  effectiveSelection.modelId === model.id && (
                                    <span className="ml-auto text-neutral-200">
                                      ✓
                                    </span>
                                  )}
                              </div>
                            </button>
                          ))}
                          {group.models.length === 0 &&
                            !(
                              effectiveSelection.providerId ===
                                group.providerId &&
                              effectiveSelection.modelId !== null
                            ) && (
                              <div className="px-3 py-2 text-xs text-neutral-500">
                                {group.isModelListLoaded
                                  ? "No models available yet."
                                  : "Models loading..."}
                              </div>
                            )}
                        </div>
                      </div>
                    ))}
                </>
              )}
            </div>
            {hasMoreSelectedProviderModels &&
              canLoadMoreSelectedProviderModels && (
                <div className="border-t border-neutral-800 p-2">
                  <button
                    type="button"
                    onClick={() => {
                      void handleLoadMore();
                    }}
                    disabled={isLoadingMoreSelectedProviderModels || isLoading}
                    className="w-full rounded-md border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {isLoadingMoreSelectedProviderModels
                      ? "Loading..."
                      : "Load more"}
                  </button>
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
