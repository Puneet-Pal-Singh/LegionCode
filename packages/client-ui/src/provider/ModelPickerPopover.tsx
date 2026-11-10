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

import React, { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  AXIS_PROVIDER_ID,
  type BYOKCredential as ProviderCredential,
  type ProviderProductPolicy,
  canShowProviderInPrimaryUi,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import {
  type ModelPickerDiscoveryView as ProviderModelDiscoveryView,
  type ModelPickerModel as ProviderModelOption,
  type ModelPickerModelsMetadata as ProviderModelsMetadata,
} from "./modelPickerTypes.js";
import { isProviderModelAvailable } from "./providerModelAvailability.js";
import { formatModelDisplayName } from "./modelDisplayName.js";
import { ModelPickerDetailsPanel } from "./ModelPickerDetailsPanel.js";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss.js";
import { useViewportPopoverPosition } from "../hooks/useViewportPopoverPosition.js";

const VIEWPORT_PADDING_PX = 12;
const POPOVER_GAP_PX = 8;
const PREFERRED_POPOVER_WIDTH_PX = 304;
const MIN_POPOVER_WIDTH_PX = 248;
const MODEL_DETAILS_GAP_PX = 8;
const MODEL_DETAILS_WIDTH_PX = 256;
const ESTIMATED_MODEL_DETAILS_HEIGHT_PX = 184;

/**
 * Props for ModelPickerPopover
 */
export interface ModelPickerPopoverProps {
  policy: ProviderProductPolicy;
  catalog: ProviderRegistryEntry[];
  credentials: ReadonlyArray<Pick<ProviderCredential, "providerId">>;
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
  onEnsureSelectedProviderModels?: (providerId: string) => Promise<unknown>;
  onRefreshSelectedProviderModels?: (providerId: string) => Promise<void>;
  onConnectProvider: () => void;
  onManageModels: () => void;
  isLoading?: boolean;
  disabled?: boolean;
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

interface HoveredModelDetails {
  model: ProviderModelOption;
  providerName: string;
  side: "left" | "right";
  topPx: number;
}

function resolveModelDetailsSide(
  popoverRect: DOMRect,
): "left" | "right" | null {
  const spaceRight = window.innerWidth - popoverRect.right - VIEWPORT_PADDING_PX;
  const spaceLeft = popoverRect.left - VIEWPORT_PADDING_PX;
  const requiredWidth = MODEL_DETAILS_WIDTH_PX + MODEL_DETAILS_GAP_PX;

  if (spaceRight >= requiredWidth) return "right";
  if (spaceLeft >= requiredWidth) return "left";
  return null;
}

function resolveModelDetailsTop(
  rowRect: DOMRect,
  popoverRect: DOMRect,
): number {
  const maxViewportTop = Math.max(
    VIEWPORT_PADDING_PX,
    window.innerHeight - ESTIMATED_MODEL_DETAILS_HEIGHT_PX - VIEWPORT_PADDING_PX,
  );
  const viewportTop = Math.min(
    Math.max(VIEWPORT_PADDING_PX, rowRect.top),
    maxViewportTop,
  );
  return Math.max(0, viewportTop - popoverRect.top);
}

function formatProviderDisplayName(
  providerId: string,
  displayName: string,
): string {
  return providerId === AXIS_PROVIDER_ID ? "Axis (Free)" : displayName;
}

function resolveEffectiveSelection(
  catalog: ProviderRegistryEntry[],
  providerModels: Record<string, ProviderModelOption[]>,
  selectedProviderId: string | null,
  selectedModelId: string | null,
  policy: ProviderProductPolicy,
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
    return resolveAxisDefaultSelection(catalog, providerModels, policy);
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

  return resolveAxisDefaultSelection(catalog, providerModels, policy);
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
  policy: ProviderProductPolicy,
): EffectiveSelection {
  if (!canShowProviderInPrimaryUi(policy, AXIS_PROVIDER_ID)) {
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
  credentials: ReadonlyArray<Pick<ProviderCredential, "providerId">>,
): Set<string> {
  return new Set(credentials.map((credential) => credential.providerId));
}

/**
 * ModelPickerPopover Component
 */
export function ModelPickerPopover({
  policy,
  catalog,
  credentials,
  providerModels,
  visibleModelIds,
  selectedProviderId,
  selectedModelId,
  hasMoreSelectedProviderModels = false,
  isLoadingMoreSelectedProviderModels = false,
  onSelectModel,
  onLoadMoreSelectedProviderModels,
  onEnsureSelectedProviderModels,
  onConnectProvider,
  onManageModels,
  isLoading = false,
  disabled = false,
  isHydratingVisibleModels = false,
}: ModelPickerPopoverProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => { if (disabled) setIsOpen(false); }, [disabled]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectingModelId, setSelectingModelId] = useState<string | null>(null);
  const [hoveredModel, setHoveredModel] = useState<HoveredModelDetails | null>(
    null,
  );
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverContentRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverPosition = useViewportPopoverPosition(
    isOpen && !disabled,
    triggerButtonRef,
    popoverContentRef,
    {
      align: "auto",
      placement: "auto",
      viewportPadding: VIEWPORT_PADDING_PX,
      gap: POPOVER_GAP_PX,
      preferredWidth: PREFERRED_POPOVER_WIDTH_PX,
      minWidth: MIN_POPOVER_WIDTH_PX,
    },
  );
  const closePopover = useCallback(() => {
    setIsOpen(false);
    setHoveredModel(null);
  }, []);
  const dismissRefs = useMemo(() => [popoverContentRef], []);
  useOutsideDismiss(popoverRef, isOpen && !disabled, closePopover, {
    additionalRefs: dismissRefs,
    escapeFocusRef: triggerButtonRef,
  });
  useEffect(() => {
    setHoveredModel(null);
  }, [
    popoverPosition.left,
    popoverPosition.top,
    popoverPosition.width,
    popoverPosition.maxHeight,
  ]);
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
        policy,
      ),
    [catalog, providerModels, selectedProviderId, selectedModelId, policy],
  );

  // Build provider groups from catalog and models
  const providerGroups = useMemo((): ProviderGroup[] => {
    return catalog
      .filter((entry) => {
        if (
          !canShowProviderInPrimaryUi(policy, entry.providerId)
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
  }, [catalog, connectedProviderIds, providerModels, policy]);

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
      return policy.isByokFirstProduction &&
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

    return `${formatProviderDisplayName(provider.providerId, provider.displayName)}: ${formatModelDisplayName(model)}`;
  }, [connectedProviderIds, effectiveSelection, catalog, providerModels, policy]);
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
      requestAnimationFrame(() => {
        const trigger = triggerButtonRef.current;
        if (
          trigger?.isConnected &&
          !trigger.disabled &&
          !popoverContentRef.current &&
          document.activeElement === document.body
        ) trigger.focus();
      });
    } catch (error) {
      console.error(
        "[model-picker/select] Failed to persist model selection:",
        error,
      );
    } finally {
      setSelectingModelId(null);
    }
  };

  const handleLoadMore = async (): Promise<void> => {
    const providerId = selectedProviderId ?? effectiveSelection.providerId;
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

  const canLoadMoreSelectedProviderModels = Boolean(
    onLoadMoreSelectedProviderModels,
  );
  const isLoadingModelsInline =
    !isLoading &&
    (isLoadingMoreSelectedProviderModels || isHydratingVisibleModels);

  useEffect(() => {
    if (!isOpen || !onEnsureSelectedProviderModels) {
      return;
    }
    const providerId = selectedProviderId ?? effectiveSelection.providerId;
    if (!providerId) {
      return;
    }
    void onEnsureSelectedProviderModels(providerId).catch((error) => {
      console.error(
        "[model-picker/load-selected] Failed to load selected provider models:",
        error,
      );
    });
  }, [
    effectiveSelection.providerId,
    isOpen,
    onEnsureSelectedProviderModels,
    selectedProviderId,
  ]);

  // Wait for measured placement before focusing, without scrolling the composer.
  useEffect(() => {
    if (isOpen && popoverPosition.visibility === "visible") {
      searchInputRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen, popoverPosition.visibility]);

  const handleToggle = (): void => {
    setHoveredModel(null);
    setIsOpen((current) => !current);
  };

  const showModelDetails = (
    model: ProviderModelOption,
    providerName: string,
    row: HTMLButtonElement,
  ): void => {
    const popoverRect = popoverContentRef.current?.getBoundingClientRect();
    if (!popoverRect) return;
    const side = resolveModelDetailsSide(popoverRect);
    if (!side) {
      setHoveredModel(null);
      return;
    }
    const rowRect = row.getBoundingClientRect();
    setHoveredModel({
      model,
      providerName,
      side,
      topPx: resolveModelDetailsTop(rowRect, popoverRect),
    });
  };
  return (
    <div ref={popoverRef} className="relative min-w-0 max-w-full">
      {/* Trigger Button */}
      <button
        ref={triggerButtonRef}
        type="button"
        disabled={disabled}
        onClick={disabled ? undefined : handleToggle}
        className={`
          inline-flex h-8 min-w-0 max-w-[min(18rem,100%,calc(100vw-6rem))] items-center gap-2 rounded-lg
          px-2 text-sm font-medium text-neutral-400
          transition-colors hover:bg-neutral-800/70 hover:text-neutral-100
          focus:outline-none focus:ring-1 focus:ring-zinc-400
        `}
        aria-label="Open model picker"
        aria-expanded={isOpen}
        title={triggerLabel}
      >
        <span className="truncate max-w-[14rem]">{triggerLabel}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Popover Content */}
      {isOpen && !disabled && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverContentRef}
              className="fixed z-50"
              style={popoverPosition}
            >
          <div
            data-testid="model-picker-popover"
            className="ui-surface-popover flex min-h-0 max-h-96 flex-col overflow-hidden"
            style={{
              maxHeight: popoverPosition.maxHeight === undefined
                ? undefined
                : `min(24rem, ${popoverPosition.maxHeight}px)`,
            }}
          >
            {!isLoading && (
              <>
                <div className="shrink-0 border-b border-neutral-800 p-2">
                  <div className="relative flex-1">
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
                    />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Search models or providers..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={`
                      ui-input h-9 w-full bg-black/20
                      pl-9 pr-3 text-sm text-neutral-100 placeholder-neutral-500
                    `}
                    />
                  </div>
                </div>
              </>
            )}

            {/* Provider Groups */}
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              style={isLoading ? {
                minHeight: popoverPosition.maxHeight === undefined
                  ? "12rem"
                  : `min(12rem, ${popoverPosition.maxHeight}px)`,
              } : undefined}
            >
              {isLoadingModelsInline && (
                <div
                  role="status"
                  aria-live="polite"
                  className="shrink-0 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400"
                >
                  {modelLoadingLabel}
                </div>
              )}
              <div
                data-testid="model-picker-model-list"
                onScroll={() => setHoveredModel(null)}
                className={`min-h-0 overflow-y-auto flex-1 ${
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
                      : policy.isByokFirstProduction &&
                          connectedProviderIds.size === 0
                        ? "Connect a BYOK provider to choose models."
                        : "No models available yet."}
                  </div>
                ) : (
                  <>
                    {axisDefaultGroup && (
                      <div className="border-b border-neutral-800/80">
                        <div className="sticky top-0 bg-[#111112] px-3 py-2">
                          <h3 className="text-xs font-medium text-neutral-500">
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
                              onPointerEnter={(event) =>
                                showModelDetails(
                                  model,
                                  axisDefaultGroup.displayName,
                                  event.currentTarget,
                                )
                              }
                              onFocus={(event) =>
                                showModelDetails(
                                  model,
                                  axisDefaultGroup.displayName,
                                  event.currentTarget,
                                )
                              }
                              className={`
                            min-h-9 w-full px-3 py-1.5 text-left text-sm
                            transition-colors disabled:opacity-50
                            ${
                              effectiveSelection.providerId ===
                                axisDefaultGroup.providerId &&
                              effectiveSelection.modelId === model.id
                                ? "bg-neutral-800 text-neutral-100"
                                : "text-neutral-400 hover:bg-neutral-800/50"
                            }
                          `}
                              title={`${formatModelDisplayName(model)} (${model.id})`}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <p className="truncate font-medium">
                                  {formatModelDisplayName(model)}
                                </p>
                                {effectiveSelection.providerId ===
                                  axisDefaultGroup.providerId &&
                                  effectiveSelection.modelId === model.id && (
                                    <>
                                      <span className="sr-only">✓</span>
                                      <Check
                                        className="ml-auto text-neutral-100"
                                        size={14}
                                      />
                                    </>
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
                          <div className="sticky top-0 bg-[#111112] px-3 py-2">
                            <h3 className="text-xs font-medium text-neutral-500">
                              {group.displayName}
                            </h3>
                          </div>
                          <div className="py-1">
                            {effectiveSelection.providerId ===
                              group.providerId &&
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
                                onPointerEnter={(event) =>
                                  showModelDetails(
                                    model,
                                    group.displayName,
                                    event.currentTarget,
                                  )
                                }
                                onFocus={(event) =>
                                  showModelDetails(
                                    model,
                                    group.displayName,
                                    event.currentTarget,
                                  )
                                }
                                className={`
                              min-h-9 w-full px-3 py-1.5 text-left text-sm
                              transition-colors disabled:opacity-50
                              ${
                                effectiveSelection.providerId ===
                                  group.providerId &&
                                effectiveSelection.modelId === model.id
                                  ? "bg-neutral-800 text-neutral-100"
                                  : "text-neutral-400 hover:bg-neutral-800/50"
                              }
                            `}
                                title={`${formatModelDisplayName(model)} (${model.id})`}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <p className="min-w-0 flex-1 truncate font-medium text-neutral-200">
                                    {formatModelDisplayName(model)}
                                  </p>
                                  {!isProviderModelAvailable(model) && (
                                    <span className="ml-auto text-[10px] uppercase tracking-wide text-amber-300">
                                      Unavailable
                                    </span>
                                  )}
                                  {effectiveSelection.providerId ===
                                    group.providerId &&
                                    effectiveSelection.modelId === model.id && (
                                      <>
                                        <span className="sr-only">✓</span>
                                        <Check
                                          className="ml-auto shrink-0 text-neutral-100"
                                          size={14}
                                        />
                                      </>
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
                  <div className="shrink-0 border-t border-neutral-800 p-2">
                    <button
                      type="button"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        void handleLoadMore();
                      }}
                      disabled={
                        isLoadingMoreSelectedProviderModels || isLoading
                      }
                      className="w-full rounded-md border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {isLoadingMoreSelectedProviderModels
                        ? "Loading..."
                        : "Load more"}
                    </button>
                  </div>
                )}
              {!isLoading ? (
                <div className="flex shrink-0 items-center justify-between border-t border-neutral-800 p-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      onManageModels();
                    }}
                    className="ui-popover-item flex-1 gap-2"
                    aria-label="Manage model visibility"
                  >
                    <SlidersHorizontal size={15} className="text-neutral-400" />
                    Manage models
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      onConnectProvider();
                    }}
                    className="flex size-9 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
                    aria-label="Connect provider"
                    title="Connect provider"
                  >
                    <Plus size={15} />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {hoveredModel ? (
            <ModelPickerDetailsPanel
              model={hoveredModel.model}
              providerName={hoveredModel.providerName}
              side={hoveredModel.side}
              topPx={hoveredModel.topPx}
            />
          ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
