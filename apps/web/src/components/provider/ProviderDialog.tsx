/**
 * Unified Provider Dialog Component
 *
 * Single provider/credential/model UI surface used in settings and composer.
 * Replaces duplicate provider selectors throughout the app.
 *
 * Tabs:
 * - Connected: Active credentials by provider
 * - Available: Add new credentials
 * - Preferences: Explicit selection policy
 * - Session: Quick-switch for current chat session
 */

import React, { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import {
  BYOKCredential as ProviderCredential,
  BYOKPreference as ProviderPreference,
  ProviderConnectionConfig,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import { type ProviderModelOption } from "../../services/api/providerClient.js";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery.js";
import { ConnectProviderChooser } from "./ConnectProviderChooser.js";
import { ManageModelsDialog } from "./ManageModelsDialog.js";

/**
 * Provider Dialog Props
 */
export interface ProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  mode?: "settings" | "composer";
  initialTab?: "connected" | "available" | "preferences" | "session";
  initialView?: "default" | "manage-models";
  variant?: "full" | "connect-only" | "manage-models-only";
}

/**
 * ProviderDialog Component
 */
export function ProviderDialog({
  isOpen,
  onClose,
  mode = "settings",
  initialTab,
  initialView = "default",
  variant = "full",
}: ProviderDialogProps): React.ReactElement | null {
  const {
    catalog,
    credentials,
    providerModels,
    manageProviderModels,
    visibleModelIds,
    loadingModelsForProviderId,
    loadingManageModelsForProviderIds,
    preferences,
    selectedProviderId,
    selectedCredentialId,
    selectedModelId,
    status,
    error,
    connectCredential,
    disconnectCredential,
    validateCredential,
    loadProviderModels,
    loadManageProviderModels,
    applySessionSelection,
    toggleModelVisibility,
    setProviderVisibleModels,
  } = useProviderStore();

  const [activeTab, setActiveTab] = useState<
    "connected" | "available" | "preferences" | "session"
  >(initialTab ?? (mode === "composer" ? "session" : "connected"));

  const [validatingCredentialId, setValidatingCredentialId] = useState<
    string | null
  >(null);

  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [showManageModels, setShowManageModels] = useState(false);
  const [manageOnlyView, setManageOnlyView] = useState<"manage" | "connect">(
    "manage",
  );
  const [connectOnlyView, setConnectOnlyView] = useState<"connect" | "manage">(
    "connect",
  );
  const [manageModelsGuidance, setManageModelsGuidance] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const [connectToasts, setConnectToasts] = useState<
    Array<{
      id: string;
      providerName: string;
      description: string;
    }>
  >([]);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(
        initialTab ?? (mode === "composer" ? "session" : "connected"),
      );
      if (initialView === "manage-models") {
        setShowManageModels(true);
      }
      return;
    }
    setShowManageModels(false);
    setConnectError(null);
    setConnectSuccess(null);
    setIsConnecting(false);
    setManageOnlyView("manage");
    setConnectOnlyView("connect");
    setManageModelsGuidance(null);
  }, [initialTab, initialView, isOpen, mode]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();

      if (variant === "full" && showManageModels) {
        setShowManageModels(false);
        return;
      }

      onClose();
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, showManageModels, variant]);

  if (!isOpen) return null;

  /**
   * Core credential connection logic (extracted for reuse)
   */
  const doConnect = async (
    providerId: string,
    secret: string,
    labelValue: string,
    config?: ProviderConnectionConfig,
  ): Promise<void> => {
    setConnectError(null);
    setConnectSuccess(null);

    if (!providerId || !secret) {
      setConnectError("Provider and API key are required");
      return;
    }

    setIsConnecting(true);
    try {
      await connectCredential({
        providerId,
        secret,
        label: labelValue || undefined,
        config,
      });

      const providerName =
        catalog.find((entry) => entry.providerId === providerId)?.displayName ??
        providerId;
      const successMessage = "API key saved and provider connected.";
      setConnectSuccess(successMessage);
      setManageModelsGuidance({
        title: `${providerName} connected. Choose your models next.`,
        description:
          "Select which models from this provider should appear in the model picker before you continue.",
      });
      setConnectToasts((current) => [
        {
          id: crypto.randomUUID(),
          providerName,
          description:
            "Choose the models you want to show in the model selector next.",
        },
        ...current,
      ]);

      if (variant === "manage-models-only") {
        setManageOnlyView("manage");
      } else if (variant === "connect-only") {
        setConnectOnlyView("manage");
      } else if (variant === "full") {
        setActiveTab("connected");
        setShowManageModels(true);
      } else {
        onClose();
      }
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Failed to connect credential",
      );
    } finally {
      setIsConnecting(false);
    }
  };

  /**
   * Handle credential validation
   */
  const handleValidate = async (
    credentialId: string,
    mode: "format" | "live",
  ) => {
    setValidatingCredentialId(credentialId);

    try {
      await validateCredential(credentialId, mode);
    } catch {
      // Error handled by store
    } finally {
      setValidatingCredentialId(null);
    }
  };

  /**
   * Handle selection change (session tab)
   */
  const handleSessionSelect = async (
    providerId: string,
    credentialId: string,
    modelId?: string,
  ) => {
    if (!credentialId) {
      return;
    }

    const resolvedModelId =
      modelId ??
      providerModels[providerId]?.[0]?.id ??
      catalog.find((entry) => entry.providerId === providerId)?.defaultModelId;
    try {
      await applySessionSelection({
        providerId,
        credentialId,
        modelId: resolvedModelId,
      });
    } catch {
      // Error shown in UI
    }
  };

  const selectedProviderModelOptions = selectedProviderId
    ? (providerModels[selectedProviderId] ?? [])
    : [];
  const isSelectedProviderModelLoading =
    loadingModelsForProviderId !== null &&
    loadingModelsForProviderId === selectedProviderId;
  const statusRecovery = getProviderRecoveryAdvice(error);

  const renderConnectProviderDialog = (
    handleClose: () => void,
  ): React.ReactElement => (
    <div
      data-testid="provider-dialog-overlay"
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-3"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
      role="presentation"
    >
      <div
        className="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[82vh] overflow-hidden flex flex-col"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-provider-dialog-title"
      >
        <div className="px-5 py-3.5 flex items-center justify-between">
          <h2
            id="connect-provider-dialog-title"
            className="text-lg font-semibold tracking-tight"
          >
            Connect provider
          </h2>
          <button
            onClick={handleClose}
            className="text-neutral-500 hover:text-neutral-300"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 pb-5 overflow-auto">
          {status === "error" && error && (
            <div className="mb-4 bg-red-950/40 border border-red-800 px-4 py-3 text-red-200 text-sm space-y-1 rounded-lg">
              <p>{statusRecovery.message}</p>
              <p className="text-xs text-red-300">
                {statusRecovery.remediation}
              </p>
            </div>
          )}
          <ConnectProviderChooser
            catalog={catalog}
            error={connectError}
            success={connectSuccess}
            isConnecting={isConnecting}
            presentation="plain"
            showTitle={false}
            onConnect={async (providerId, secret, label, config) => {
              await doConnect(providerId, secret, label || "", config);
            }}
            onErrorClear={() => setConnectError(null)}
          />
        </div>
      </div>
    </div>
  );

  if (variant === "manage-models-only") {
    if (manageOnlyView === "connect") {
      return renderConnectProviderDialog(onClose);
    }

    return (
      <ManageModelsDialog
        isOpen={isOpen}
        onClose={onClose}
        catalog={catalog}
        credentials={credentials}
        providerModels={manageProviderModels}
        visibleModelIds={visibleModelIds}
        loadingProviderModelIds={loadingManageModelsForProviderIds}
        onLoadProviderModels={loadManageProviderModels}
        onToggleModelVisibility={toggleModelVisibility}
        onSetProviderVisibleModels={setProviderVisibleModels}
        onConnectProvider={() => setManageOnlyView("connect")}
        guidanceBanner={manageModelsGuidance}
      />
    );
  }

  if (variant === "connect-only") {
    if (connectOnlyView === "manage") {
      return (
        <>
          <ManageModelsDialog
            isOpen={isOpen}
            onClose={onClose}
            catalog={catalog}
            credentials={credentials}
            providerModels={manageProviderModels}
            visibleModelIds={visibleModelIds}
            loadingProviderModelIds={loadingManageModelsForProviderIds}
            onLoadProviderModels={loadManageProviderModels}
            onToggleModelVisibility={toggleModelVisibility}
            onSetProviderVisibleModels={setProviderVisibleModels}
            guidanceBanner={manageModelsGuidance}
          />
          <ProviderConnectToastStack
            toasts={connectToasts}
            onDismiss={(toastId) =>
              setConnectToasts((current) =>
                current.filter((toast) => toast.id !== toastId),
              )
            }
          />
        </>
      );
    }

    return (
      <>
        {renderConnectProviderDialog(onClose)}
        <ProviderConnectToastStack
          toasts={connectToasts}
          onDismiss={(toastId) =>
            setConnectToasts((current) =>
              current.filter((toast) => toast.id !== toastId),
            )
          }
        />
      </>
    );
  }

  return (
    <div
      data-testid="provider-dialog-overlay"
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-3"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        className="bg-neutral-900 text-neutral-100 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-settings-dialog-title"
      >
        {/* Header */}
        <div className="border-b border-neutral-700 px-6 py-4 flex items-center justify-between">
          <h2
            id="provider-settings-dialog-title"
            className="text-lg font-semibold"
          >
            Provider & Model Settings
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-neutral-700 flex gap-1 px-6">
          {[
            { id: "connected", label: "Connected" },
            { id: "available", label: "Available" },
            { id: "preferences", label: "Preferences" },
            {
              id: "session",
              label: mode === "composer" ? "Active Session" : "Quick Select",
            },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() =>
                setActiveTab(
                  tab.id as
                    | "connected"
                    | "available"
                    | "preferences"
                    | "session",
                )
              }
              className={`px-4 py-3 border-b-2 transition ${
                activeTab === tab.id
                  ? "border-blue-500 text-blue-400 font-medium"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {status === "error" && error && (
            <div className="bg-red-950/40 border-b border-red-800 px-6 py-3 text-red-200 text-sm space-y-1">
              <p>{statusRecovery.message}</p>
              <p className="text-xs text-red-300">
                {statusRecovery.remediation}
              </p>
            </div>
          )}

          {activeTab === "connected" && (
            <ConnectedTab
              credentials={credentials}
              onDisconnect={disconnectCredential}
              onValidate={handleValidate}
              validatingId={validatingCredentialId}
              onOpenAvailableTab={() => setActiveTab("available")}
            />
          )}

          {activeTab === "available" && (
            <div className="p-6">
              <ConnectProviderChooser
                catalog={catalog}
                error={connectError}
                success={connectSuccess}
                isConnecting={isConnecting}
                onConnect={async (providerId, secret, label, config) => {
                  await doConnect(providerId, secret, label || "", config);
                }}
                onErrorClear={() => setConnectError(null)}
              />
            </div>
          )}

          {activeTab === "preferences" && (
            <PreferencesTab preferences={preferences} />
          )}

          {activeTab === "session" && (
            <SessionTab
              catalog={catalog}
              credentials={credentials}
              selectedProviderId={selectedProviderId}
              selectedCredentialId={selectedCredentialId}
              selectedModelId={selectedModelId}
              modelOptions={selectedProviderModelOptions}
              isModelLoading={isSelectedProviderModelLoading}
              onLoadModels={loadProviderModels}
              onSelect={handleSessionSelect}
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-700 px-6 py-3 flex justify-between gap-3">
          <button
            onClick={() => setShowManageModels(true)}
            className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 rounded transition"
          >
            Manage Models
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-neutral-300 hover:bg-neutral-800 rounded transition"
            >
              Close
            </button>
            {mode === "composer" && (
              <button
                onClick={onClose}
                className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded transition"
              >
                Use Selected
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Manage Models Dialog */}
      <ManageModelsDialog
        isOpen={showManageModels}
        onClose={() => setShowManageModels(false)}
        catalog={catalog}
        credentials={credentials}
        providerModels={manageProviderModels}
        visibleModelIds={visibleModelIds}
        loadingProviderModelIds={loadingManageModelsForProviderIds}
        onLoadProviderModels={loadManageProviderModels}
        onToggleModelVisibility={toggleModelVisibility}
        onSetProviderVisibleModels={setProviderVisibleModels}
        onConnectProvider={() => {
          setShowManageModels(false);
          setActiveTab("available");
        }}
        guidanceBanner={manageModelsGuidance}
      />

      <ProviderConnectToastStack
        toasts={connectToasts}
        onDismiss={(toastId) =>
          setConnectToasts((current) =>
            current.filter((toast) => toast.id !== toastId),
          )
        }
      />
    </div>
  );
}

function ProviderConnectToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Array<{
    id: string;
    providerName: string;
    description: string;
  }>;
  onDismiss: (toastId: string) => void;
}): React.ReactElement | null {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto rounded-xl border border-zinc-700/80 bg-[#0f1117]/95 px-4 py-3 text-zinc-100 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 text-zinc-300" size={16} />
              <div>
                <p className="text-lg font-medium leading-tight">
                  {toast.providerName} connected
                </p>
                <p className="mt-1 text-sm text-zinc-300">
                  {toast.description}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Connected Tab - List of active credentials
 */
function ConnectedTab({
  credentials,
  onDisconnect,
  onValidate,
  validatingId,
  onOpenAvailableTab,
}: {
  credentials: ProviderCredential[];
  onDisconnect: (id: string) => Promise<void>;
  onValidate: (id: string, mode: "format" | "live") => Promise<void>;
  validatingId: string | null;
  onOpenAvailableTab: () => void;
}): React.ReactElement {
  return (
    <div className="p-6">
      {credentials.length === 0 ? (
        <div className="text-center py-8 space-y-3">
          <p className="text-neutral-400">No provider keys connected yet.</p>
          <button
            type="button"
            onClick={onOpenAvailableTab}
            className="text-sm px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 transition"
          >
            Add Provider Key
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {credentials.map((cred) => (
            <div
              key={cred.credentialId}
              className="border border-neutral-700 rounded-lg p-4 hover:bg-neutral-800/50 transition"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium">
                    {cred.label || `${cred.providerId} (default)`}
                  </h3>
                  <p className="text-sm text-neutral-400">
                    Provider: {cred.providerId}
                  </p>
                  {cred.keyFingerprint && (
                    <p className="text-xs text-neutral-500 mt-1">
                      Fingerprint: {cred.keyFingerprint.slice(0, 16)}...
                    </p>
                  )}
                  <div className="flex gap-2 mt-2">
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        cred.status === "connected"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {cred.status}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => onValidate(cred.credentialId, "format")}
                    disabled={validatingId === cred.credentialId}
                    className="text-sm px-3 py-1 border border-neutral-600 rounded hover:bg-neutral-800 disabled:opacity-50 transition"
                  >
                    {validatingId === cred.credentialId
                      ? "Validating..."
                      : "Test"}
                  </button>
                  <button
                    onClick={() => onDisconnect(cred.credentialId)}
                    className="text-sm px-3 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50 transition"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Preferences Tab - Explicit selection policy.
 */
function PreferencesTab({
  preferences,
}: {
  preferences: ProviderPreference | null;
}): React.ReactElement {
  const defaultSelection = preferences?.defaultProviderId
    ? `${preferences.defaultProviderId} / ${preferences.defaultModelId ?? "unset"}`
    : "not configured";

  return (
    <div className="p-6 space-y-6">
      <div className="bg-blue-950/30 border border-blue-900 rounded p-4 text-sm text-blue-200 space-y-2">
        <p className="font-medium text-blue-100">Explicit Selection Policy</p>
        <p>
          Runtime execution requires an explicit provider and model resolution.
          No hidden provider fallback is applied.
        </p>
        <p>Current defaults: {defaultSelection}</p>
      </div>
    </div>
  );
}

/**
 * Session Tab - Quick select for current chat
 */
function SessionTab({
  catalog,
  credentials,
  selectedProviderId,
  selectedCredentialId,
  selectedModelId,
  modelOptions,
  isModelLoading,
  onLoadModels,
  onSelect,
}: {
  catalog: ProviderRegistryEntry[];
  credentials: ProviderCredential[];
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;
  modelOptions: ProviderModelOption[];
  isModelLoading: boolean;
  onLoadModels: (providerId: string) => Promise<ProviderModelOption[]>;
  onSelect: (
    providerId: string,
    credentialId: string,
    modelId?: string,
  ) => void;
}): React.ReactElement {
  const availableProviders = catalog.filter((p) =>
    credentials.some((c) => c.providerId === p.providerId),
  );

  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    void onLoadModels(selectedProviderId);
  }, [onLoadModels, selectedProviderId]);

  return (
    <div className="p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium mb-2">Provider</label>
        <select
          value={selectedProviderId || ""}
          onChange={(e) => {
            const provider = e.target.value;
            const cred = credentials.find((c) => c.providerId === provider);
            if (cred) {
              onSelect(provider, cred.credentialId);
              void onLoadModels(provider);
            }
          }}
          className="w-full border border-neutral-700 bg-neutral-900 rounded px-3 py-2 text-sm"
        >
          <option value="">Select a provider...</option>
          {availableProviders.map((p) => (
            <option key={p.providerId} value={p.providerId}>
              {p.providerId === "axis" ? "Axis (Free)" : p.displayName}
            </option>
          ))}
        </select>
      </div>

      {selectedProviderId && (
        <>
          <div>
            <label className="block text-sm font-medium mb-2">Credential</label>
            <select
              value={selectedCredentialId || ""}
              onChange={(e) => {
                const credId = e.target.value;
                const cred = credentials.find((c) => c.credentialId === credId);
                if (cred) {
                  onSelect(selectedProviderId, credId);
                }
              }}
              className="w-full border border-neutral-700 bg-neutral-900 rounded px-3 py-2 text-sm"
            >
              {credentials
                .filter((c) => c.providerId === selectedProviderId)
                .map((c) => (
                  <option key={c.credentialId} value={c.credentialId}>
                    {c.label || "Default"}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Model</label>
            {modelOptions.length > 0 ? (
              <select
                value={selectedModelId || ""}
                onChange={(e) =>
                  onSelect(
                    selectedProviderId,
                    selectedCredentialId || "",
                    e.target.value,
                  )
                }
                className="w-full border border-neutral-700 bg-neutral-900 rounded px-3 py-2 text-sm"
              >
                <option value="">Select a model...</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.id})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={selectedModelId || ""}
                onChange={(e) =>
                  onSelect(
                    selectedProviderId,
                    selectedCredentialId || "",
                    e.target.value,
                  )
                }
                placeholder="e.g., gpt-4, claude-3-opus"
                className="w-full border border-neutral-700 bg-neutral-900 rounded px-3 py-2 text-sm"
              />
            )}
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-xs text-neutral-500">
                {modelOptions.length > 0
                  ? "Models fetched from provider."
                  : "No fetched models yet. You can type one manually or refresh."}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (selectedProviderId) {
                    void onLoadModels(selectedProviderId);
                  }
                }}
                className="text-xs text-blue-700 hover:text-blue-800"
              >
                {isModelLoading ? "Loading..." : "Refresh models"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
