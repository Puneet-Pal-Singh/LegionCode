/**
 * Connect Provider Chooser - Searchable Provider Selection
 *
 * Provides a search-first UX for discovering providers and a focused
 * API-key step for connecting a selected provider.
 */

import React, { useMemo, useState, useRef, useEffect } from "react";
import { Search, AlertCircle, CheckCircle, ArrowLeft } from "lucide-react";
import {
  AXIS_PROVIDER_ID,
  canShowProviderInPrimaryUi,
  isLaunchSupportedProvider,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

/**
 * Props for ConnectProviderChooser
 */
export interface ConnectProviderChooserProps {
  catalog: ProviderRegistryEntry[];
  onConnect: (providerId: string, secret: string, label?: string) => Promise<void>;
  isConnecting?: boolean;
  error?: string | null;
  success?: string | null;
  onErrorClear?: () => void;
  presentation?: "card" | "plain";
  showTitle?: boolean;
  initialSelectedProviderId?: string;
}

/**
 * Provider details with formatted display
 */
interface ProviderOption {
  entry: ProviderRegistryEntry;
  displayName: string;
}

/**
 * ConnectProviderChooser Component
 */
export function ConnectProviderChooser({
  catalog,
  onConnect,
  isConnecting = false,
  error = null,
  success = null,
  onErrorClear,
  presentation = "card",
  showTitle = true,
  initialSelectedProviderId,
}: ConnectProviderChooserProps): React.ReactElement {
  const providerOptions = useMemo((): ProviderOption[] => {
    return catalog
      .filter(
        (entry) =>
          entry.providerId !== AXIS_PROVIDER_ID &&
          canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, entry.providerId) &&
          entry.authModes.includes("api_key") &&
          isLaunchSupportedProvider(entry)
      )
      .map((entry) => ({
        entry,
        displayName: entry.displayName,
      }));
  }, [catalog]);
  const initialProviderId =
    initialSelectedProviderId &&
    providerOptions.some(
      (option) => option.entry.providerId === initialSelectedProviderId,
    )
      ? initialSelectedProviderId
      : null;
  const [view, setView] = useState<"providers" | "credentials">(
    initialProviderId ? "credentials" : "providers",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    initialProviderId,
  );
  const [apiSecret, setApiSecret] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredProviders = useMemo((): ProviderOption[] => {
    if (!searchQuery.trim()) {
      return providerOptions;
    }

    const query = searchQuery.toLowerCase();
    return providerOptions.filter(
      (option) =>
        option.displayName.toLowerCase().includes(query) ||
        option.entry.providerId.toLowerCase().includes(query)
    );
  }, [providerOptions, searchQuery]);

  const selectedProvider = selectedProviderId
    ? catalog.find((provider) => provider.providerId === selectedProviderId)
    : null;

  const handleSelectProvider = React.useCallback((providerId: string): void => {
    setSelectedProviderId(providerId);
    setView("credentials");
    setApiSecret("");
    if (onErrorClear) {
      onErrorClear();
    }
  }, [onErrorClear]);

  const handleBackToProviders = (): void => {
    setView("providers");
    setApiSecret("");
    if (onErrorClear) {
      onErrorClear();
    }
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();

    if (!selectedProviderId || !apiSecret.trim()) {
      return;
    }

    try {
      await onConnect(selectedProviderId, apiSecret);
      setApiSecret("");
    } catch {
      // Error handled by parent and displayed
    }
  };

  useEffect(() => {
    if (view === "providers" && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [view]);

  const errorRecovery = error ? getProviderRecoveryAdvice(error) : null;
  const searchLabelClassName =
    presentation === "plain"
      ? "mb-2 block text-xs font-medium text-neutral-400"
      : "mb-2 block text-xs font-medium uppercase tracking-wide text-neutral-400";
  const sectionLabelClassName =
    presentation === "plain"
      ? "mb-3 block text-sm font-medium text-neutral-400"
      : "mb-3 block text-xs font-medium uppercase tracking-wide text-neutral-400";
  const rootClassName =
    presentation === "plain"
      ? "space-y-5 text-neutral-100"
      : "space-y-5 rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-neutral-100";
  const keyInputId = selectedProvider ? `${selectedProvider.providerId}-api-key` : "api-key";

  return (
    <div className={rootClassName}>
      {showTitle && (
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Connect provider</h3>
        </div>
      )}

      {error && errorRecovery && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 p-3 space-y-1">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-red-200">{errorRecovery.message}</p>
              <p className="mt-1 text-xs text-red-300">{errorRecovery.remediation}</p>
            </div>
          </div>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-2 rounded-lg border border-green-900 bg-green-950/30 p-3">
          <CheckCircle size={16} className="text-green-400 shrink-0 mt-0.5" />
          <p className="text-sm text-green-200">{success}</p>
        </div>
      )}

      {view === "providers" && (
        <div className="space-y-4">
          <div>
            <label className={searchLabelClassName}>
              Find Provider
            </label>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-3 text-neutral-500" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search providers"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`
                  w-full rounded-lg border border-neutral-700 bg-neutral-800/80 pl-9 pr-3 py-2
                  text-sm transition-colors
                  ${
                    error
                      ? "border-red-700 bg-red-950/20 focus:ring-red-500"
                      : "focus:ring-blue-500"
                  }
                  focus:outline-none focus:ring-2
                `}
              />
            </div>
          </div>

          <div>
            <p className={sectionLabelClassName}>
              {searchQuery.trim() ? "Matches" : "Popular"}
            </p>

            {filteredProviders.length === 0 ? (
              <div className="px-1 py-6 text-center">
                <p className="text-sm text-neutral-500">
                  {searchQuery ? "No providers match your search" : "No providers available"}
                </p>
              </div>
            ) : (
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {filteredProviders.map((option) => (
                  <button
                    key={option.entry.providerId}
                    onClick={() => handleSelectProvider(option.entry.providerId)}
                    type="button"
                    disabled={isConnecting}
                    className="w-full rounded-md px-2.5 py-2 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-neutral-800/60"
                  >
                    <p className="text-sm font-medium text-neutral-100">
                      {option.displayName}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === "credentials" && selectedProvider && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleBackToProviders}
              className="inline-flex items-center gap-2 text-sm text-neutral-400 hover:text-neutral-200"
              aria-label="Back to providers"
            >
              <ArrowLeft size={14} />
              Back
            </button>
          </div>

          <div>
            <h4 className="text-xl font-semibold text-neutral-100">
              Connect {selectedProvider.displayName}
            </h4>
            <p className="mt-3 text-sm text-neutral-400">
              {selectedProvider.keyFormat?.description ??
                `Enter your ${selectedProvider.displayName} API key to connect this provider.`}
            </p>
          </div>

          <div>
            <label
              htmlFor={keyInputId}
              className="mb-2 block text-sm font-medium text-neutral-200"
            >
              {selectedProvider.displayName} API key
            </label>
            <input
              id={keyInputId}
              type="password"
              value={apiSecret}
              onChange={(e) => {
                setApiSecret(e.target.value);
                if (onErrorClear) {
                  onErrorClear();
                }
              }}
              placeholder="API key"
              required
              disabled={isConnecting}
              className={`
                w-full rounded-lg border border-neutral-700 bg-neutral-800/80 px-3 py-2 text-sm
                transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                ${error ? "border-red-700 bg-red-950/20" : ""}
                focus:outline-none focus:ring-2 focus:ring-blue-500
              `}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={isConnecting || !apiSecret.trim()}
              className={`
                inline-flex px-4 py-2 rounded-lg font-medium text-sm
                transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                ${
                  isConnecting || !apiSecret.trim()
                    ? "bg-neutral-700 text-neutral-400"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }
              `}
            >
              {isConnecting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
