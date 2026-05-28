/**
 * Manage Models Dialog - Model Visibility Curation
 *
 * Allows users to curate which models appear in the composer picker by
 * enabling/disabling models per provider.
 *
 * Features:
 * - Group models by provider
 * - Toggle visibility per model
 * - Search/filter models
 * - Preserve current selection validity
 */

import React, { useEffect, useMemo, useState } from "react";
import { Search, Plus } from "lucide-react";
import {
  BYOKCredential as ProviderCredential,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { type ProviderModelOption } from "../../services/api/providerClient.js";

/**
 * Provider group with visibility state
 */
interface ProviderGroup {
  providerId: string;
  displayName: string;
  models: ProviderModelOption[];
  isModelListLoaded: boolean;
}

/**
 * Provider group with filtered models
 */
interface FilteredProviderGroup extends ProviderGroup {
  filteredModels: ProviderModelOption[];
}

const CONNECT_PROVIDER_BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-200 transition hover:bg-neutral-800";
const VISIBILITY_ROW_CLASS =
  "grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-3 px-2";

function getProviderCompanySortKey(
  providerId: string,
  model: ProviderModelOption,
): string {
  if (providerId !== "openrouter") {
    return providerId;
  }

  const [author] = model.id.split("/");
  return (author ?? "zzzz").trim().toLowerCase();
}

function sortProviderModels(
  providerId: string,
  models: ProviderModelOption[],
): ProviderModelOption[] {
  return [...models].sort((left, right) => {
    const companyCompare = getProviderCompanySortKey(
      providerId,
      left,
    ).localeCompare(getProviderCompanySortKey(providerId, right));
    if (companyCompare !== 0) {
      return companyCompare;
    }

    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

/**
 * Build provider groups from catalog, models, and visibility state
 */
function buildProviderGroups(
  catalog: ProviderRegistryEntry[],
  credentials: ProviderCredential[],
  providerModels: Record<string, ProviderModelOption[]>,
  loadingProviderModelIds: Record<string, boolean>,
): ProviderGroup[] {
  const connectedProviderIds = new Set(
    credentials.map((credential) => credential.providerId),
  );

  return catalog
    .filter(
      (entry) =>
        connectedProviderIds.has(entry.providerId) ||
        Object.prototype.hasOwnProperty.call(providerModels, entry.providerId),
    )
    .map((entry) => {
      const models = sortProviderModels(
        entry.providerId,
        providerModels[entry.providerId] || [],
      );
      return {
        providerId: entry.providerId,
        displayName: entry.displayName,
        models,
        isModelListLoaded:
          Object.prototype.hasOwnProperty.call(
            providerModels,
            entry.providerId,
          ) && !loadingProviderModelIds[entry.providerId],
      };
    });
}

/**
 * Filter provider groups and models based on search query
 */
function filterProviderGroups(
  providerGroups: ProviderGroup[],
  searchQuery: string,
): FilteredProviderGroup[] {
  if (!searchQuery.trim()) {
    return providerGroups.map((group) => ({
      ...group,
      filteredModels: group.models,
    }));
  }

  const query = searchQuery.toLowerCase();
  return providerGroups
    .map((group) => ({
      ...group,
      filteredModels: group.displayName.toLowerCase().includes(query)
        ? group.models
        : group.models.filter(
            (model) =>
              model.name.toLowerCase().includes(query) ||
              model.id.toLowerCase().includes(query),
          ),
    }))
    .filter(
      (group) =>
        group.filteredModels.length > 0 ||
        group.displayName.toLowerCase().includes(query),
    );
}

function ConnectProviderButton({
  onConnectProvider,
}: {
  onConnectProvider: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onConnectProvider}
      className={CONNECT_PROVIDER_BUTTON_CLASS}
      type="button"
    >
      <Plus size={12} />
      Connect provider
    </button>
  );
}

/**
 * Props for ManageModelsDialog
 */
export interface ManageModelsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  catalog: ProviderRegistryEntry[];
  credentials: ProviderCredential[];
  providerModels: Record<string, ProviderModelOption[]>;
  visibleModelIds: Record<string, Set<string>>;
  loadingProviderModelIds: Record<string, boolean>;
  onLoadProviderModels?: (
    providerId: string,
    limit?: number,
  ) => Promise<unknown>;
  onToggleModelVisibility: (providerId: string, modelId: string) => void;
  onSetProviderVisibleModels: (providerId: string, modelIds: string[]) => void;
  onConnectProvider?: () => void;
  guidanceBanner?: {
    title: string;
    description: string;
  } | null;
}

/**
 * ManageModelsDialog Component
 */
export function ManageModelsDialog({
  isOpen,
  onClose,
  catalog,
  credentials,
  providerModels,
  visibleModelIds,
  loadingProviderModelIds,
  onLoadProviderModels,
  onToggleModelVisibility,
  onSetProviderVisibleModels,
  onConnectProvider,
  guidanceBanner = null,
}: ManageModelsDialogProps): React.ReactElement | null {
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!isOpen || !onLoadProviderModels) {
      return;
    }

    const connectedProviderIds = new Set(
      credentials.map((credential) => credential.providerId),
    );
    void Promise.allSettled(
      catalog
        .filter((entry) => connectedProviderIds.has(entry.providerId))
        .map((entry) => onLoadProviderModels(entry.providerId, 150)),
    );
  }, [catalog, credentials, isOpen, onLoadProviderModels]);

  // Build provider groups with visibility state
  const providerGroups = useMemo(() => {
    return buildProviderGroups(
      catalog,
      credentials,
      providerModels,
      loadingProviderModelIds,
    );
  }, [catalog, credentials, loadingProviderModelIds, providerModels]);

  // Filter groups and models based on search
  const filteredGroups = useMemo(() => {
    return filterProviderGroups(providerGroups, searchQuery);
  }, [providerGroups, searchQuery]);

  if (!isOpen) return null;

  return (
    <div
      data-testid="manage-models-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        className="flex w-full max-w-2xl max-h-[82vh] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-models-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-neutral-700 px-6 py-4">
          <div className="space-y-1">
            <h2
              id="manage-models-title"
              className="text-base font-semibold tracking-tight"
            >
              Manage models
            </h2>
            <p className="text-xs text-neutral-400">
              Customize which models appear in the model selector.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onConnectProvider && (
              <ConnectProviderButton onConnectProvider={onConnectProvider} />
            )}
            <button
              onClick={onClose}
              className="text-neutral-500 transition hover:text-neutral-300"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-6 py-3">
          {guidanceBanner ? (
            <div className="mb-3 rounded-lg border border-blue-900 bg-blue-950/30 px-4 py-3 text-blue-100">
              <p className="text-sm font-medium">{guidanceBanner.title}</p>
              <p className="mt-1 text-xs text-blue-200">
                {guidanceBanner.description}
              </p>
            </div>
          ) : null}
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-2.5 text-neutral-500"
            />
            <input
              type="text"
              placeholder="Search models"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-10 w-full rounded-md border border-neutral-700 bg-neutral-800/80 pl-9 pr-3 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-6 pb-4">
          {filteredGroups.length === 0 ? (
            <div className="py-8 text-center text-neutral-500 space-y-3">
              <p>
                {searchQuery
                  ? "No models match your search"
                  : "No providers connected"}
              </p>
              {!searchQuery && onConnectProvider && (
                <ConnectProviderButton onConnectProvider={onConnectProvider} />
              )}
            </div>
          ) : (
            <div className="space-y-5">
              {filteredGroups.map((group) => {
                const visibleSet = visibleModelIds[group.providerId];
                const filteredModels = group.filteredModels;
                const isProviderVisible = visibleSet
                  ? visibleSet.size > 0
                  : group.models.length > 0;
                const canToggleProviderVisibility = group.models.length > 0;

                return (
                  <div key={group.providerId} className="space-y-2.5">
                    {/* Provider Header */}
                    <div className={`${VISIBILITY_ROW_CLASS} py-0.5`}>
                      <div className="min-w-0 text-left">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                          {group.displayName}
                        </h3>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isProviderVisible}
                        aria-label={`${group.displayName} provider visibility`}
                        disabled={!canToggleProviderVisibility}
                        onClick={() =>
                          onSetProviderVisibleModels(
                            group.providerId,
                            isProviderVisible
                              ? []
                              : group.models.map((model) => model.id),
                          )
                        }
                        className={`relative inline-flex h-5 w-8 shrink-0 items-center justify-self-end rounded-full border transition ${
                          isProviderVisible
                            ? "border-blue-500 bg-blue-600"
                            : "border-neutral-600 bg-neutral-800"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                            isProviderVisible
                              ? "translate-x-4"
                              : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </div>

                    {/* Models */}
                    <div className="space-y-1">
                      {filteredModels.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-neutral-500">
                          {group.isModelListLoaded
                            ? "No models available yet."
                            : "Models loading..."}
                        </div>
                      )}
                      {filteredModels.map((model: ProviderModelOption) => {
                        const isVisible = visibleSet
                          ? visibleSet.has(model.id)
                          : true;
                        const isAvailable =
                          (model.availability ?? "available") === "available";
                        return (
                          <div
                            key={model.id}
                            className={`${VISIBILITY_ROW_CLASS} rounded-md py-1.5 transition-colors ${
                              isAvailable
                                ? "hover:bg-neutral-800/60"
                                : "opacity-70"
                            }`}
                          >
                            <div className="min-w-0 text-left">
                              <p className="text-xs font-medium text-neutral-300">
                                {model.name}
                              </p>
                              {!isAvailable && (
                                <p className="mt-0.5 text-[11px] text-amber-300">
                                  {model.unavailableReason ??
                                    "Unavailable for runtime selection"}
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={isVisible}
                              aria-label={`${model.name} visibility`}
                              disabled={!isAvailable}
                              onClick={() => {
                                onToggleModelVisibility(
                                  group.providerId,
                                  model.id,
                                );
                              }}
                              className={`relative inline-flex h-5 w-8 shrink-0 items-center justify-self-end rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                isVisible
                                  ? "border-blue-500 bg-blue-600"
                                  : "border-neutral-600 bg-neutral-800"
                              }`}
                            >
                              <span
                                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                                  isVisible
                                    ? "translate-x-4"
                                    : "translate-x-0.5"
                                }`}
                              />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-neutral-700 px-6 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
