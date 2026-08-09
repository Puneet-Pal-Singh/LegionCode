import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canShowProviderInPrimaryUi,
  isLaunchSupportedProvider,
  type BYOKCredential,
  type ProviderConnectionConfig,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import {
  Archive,
  CheckCircle2,
  Cable,
  ChevronRight,
  Cpu,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import type { SettingsSection } from "../../lib/settings-dialog-events.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";
import { ConnectProviderChooser } from "../provider/ConnectProviderChooser.js";
import { ProviderIcon } from "../provider/ProviderIcon.js";
import { Switch } from "../ui/Switch.js";
import { formatModelDisplayName } from "../provider/modelDisplayName.js";
import { ArchivedChatsSettings } from "./ArchivedChatsSettings.js";
import { HooksSettingsPanel } from "./HooksSettingsPanel.js";
import type { ProviderModelOption } from "../../services/api/providerClient.js";
import type { HookSettingsAuditReadModel } from "../../services/api/lifecycleClient.js";
import {
  updateComposerPreferences,
  useComposerPreferences,
} from "../../lib/composer-preferences";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();
const DISCONNECT_TOAST_DURATION_MS = 4_000;

interface SettingsDialogProps {
  isOpen: boolean;
  runId?: string;
  workspaceId?: string | null;
  hookAudits?: readonly HookSettingsAuditReadModel[];
  initialSection?: SettingsSection;
  onUnarchiveSession?: (sessionId: string) => Promise<void>;
  onClose: () => void;
}

type ConnectView = "overview" | "connect";

interface DisconnectToast {
  id: number;
  providerName: string;
}

interface ConnectedProviderRow {
  providerId: string;
  displayName: string;
  credential: BYOKCredential;
}

export function SettingsDialog({
  isOpen,
  runId,
  workspaceId = null,
  hookAudits = [],
  initialSection = "general",
  onUnarchiveSession = async () => undefined,
  onClose,
}: SettingsDialogProps): React.ReactElement | null {
  const {
    status,
    error,
    catalog,
    credentials,
    connectCredential,
    disconnectCredential,
    manageProviderModels,
    visibleModelIds,
    loadingManageModelsForProviderIds,
    loadManageProviderModels,
    toggleModelVisibility,
    setProviderVisibleModels,
  } = useProviderStore(runId);

  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection);
  const [connectView, setConnectView] = useState<ConnectView>("overview");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<string | null>(null);
  const [selectedProviderIdForConnect, setSelectedProviderIdForConnect] =
    useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingCredentialId, setDisconnectingCredentialId] = useState<
    string | null
  >(null);
  const [disconnectToasts, setDisconnectToasts] = useState<DisconnectToast[]>(
    [],
  );
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setActiveSection(initialSection);
    if (initialSection === "connect") {
      setConnectView("overview");
      setSelectedProviderIdForConnect(null);
    }
    setConnectError(null);
    setConnectSuccess(null);
  }, [initialSection, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleTabKey = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );

      if (!focusableElements || focusableElements.length === 0) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) {
        return;
      }

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener("keydown", handleTabKey);
    return () => window.removeEventListener("keydown", handleTabKey);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const focusables = modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      focusables?.[0]?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isOpen]);

  const connectedProviders = useMemo(
    () => buildConnectedProviderRows(catalog, credentials),
    [catalog, credentials],
  );

  const connectedProviderIds = useMemo(
    () => new Set(credentials.map((credential) => credential.providerId)),
    [credentials],
  );

  const availableProviders = useMemo(
    () =>
      catalog.filter(
        (entry) =>
          canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, entry.providerId) &&
          isLaunchSupportedProvider(entry) &&
          entry.authModes.includes("api_key") &&
          entry.providerId !== "axis" &&
          !connectedProviderIds.has(entry.providerId),
      ),
    [catalog, connectedProviderIds],
  );

  const openConnectView = useCallback((providerId?: string) => {
    setConnectError(null);
    setConnectSuccess(null);
    setSelectedProviderIdForConnect(providerId ?? null);
    setConnectView("connect");
  }, []);

  const handleSectionSelect = useCallback((section: SettingsSection): void => {
    setActiveSection(section);
    setConnectView("overview");
    setSelectedProviderIdForConnect(null);
    setConnectError(null);
    setConnectSuccess(null);
  }, []);

  const handleBackToConnectOverview = useCallback((): void => {
    setConnectView("overview");
    setSelectedProviderIdForConnect(null);
  }, []);

  const showDisconnectToast = useCallback((providerName: string): void => {
    const toastId = Date.now() + Math.floor(Math.random() * 1000);
    setDisconnectToasts((previous) => [
      ...previous,
      { id: toastId, providerName },
    ]);

    window.setTimeout(() => {
      setDisconnectToasts((previous) =>
        previous.filter((toast) => toast.id !== toastId),
      );
    }, DISCONNECT_TOAST_DURATION_MS);
  }, []);

  const handleDisconnect = useCallback(
    async (credential: BYOKCredential, providerName: string): Promise<void> => {
      setDisconnectingCredentialId(credential.credentialId);
      try {
        await disconnectCredential(credential.credentialId);
        showDisconnectToast(providerName);
      } finally {
        setDisconnectingCredentialId(null);
      }
    },
    [disconnectCredential, showDisconnectToast],
  );

  const handleConnect = useCallback(
    async (
      providerId: string,
      secret: string,
      label?: string,
      config?: ProviderConnectionConfig,
    ): Promise<void> => {
      setConnectError(null);
      setConnectSuccess(null);
      setIsConnecting(true);
      try {
        await connectCredential({
          providerId,
          secret,
          label,
          config,
        });
        setConnectSuccess("API key saved and provider connected.");
        setConnectView("overview");
        setSelectedProviderIdForConnect(null);
      } catch (connectErr) {
        setConnectError(
          connectErr instanceof Error
            ? connectErr.message
            : "Failed to connect provider key",
        );
      } finally {
        setIsConnecting(false);
      }
    },
    [connectCredential],
  );

  const dismissDisconnectToast = (toastId: number): void => {
    setDisconnectToasts((previous) =>
      previous.filter((toast) => toast.id !== toastId),
    );
  };

  if (!isOpen) {
    return null;
  }

  return (
    <>
      <div
        className="ui-overlay fixed inset-0 z-50 flex items-center justify-center p-3"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
          className="ui-surface-modal relative flex h-[82vh] w-full max-w-6xl overflow-hidden font-sans"
          onClick={(event) => event.stopPropagation()}
        >
          <aside className="ui-sidebar-surface relative z-10 flex w-72 shrink-0 flex-col border-r px-5 py-5">
            <div className="mb-4 text-sm font-semibold text-zinc-200">
              Settings
            </div>
            <nav className="space-y-5">
              <SettingsNavSection
                label="Desktop"
                items={[
                  {
                    id: "general",
                    label: "General",
                    icon: <Settings2 size={16} />,
                  },
                  {
                    id: "archived",
                    label: "Archived",
                    icon: <Archive size={16} />,
                  },
                ]}
                activeSection={activeSection}
                onSelect={handleSectionSelect}
              />
              <SettingsNavSection
                label="Server"
                items={[
                  {
                    id: "connect",
                    label: "Providers",
                    icon: <Cpu size={16} />,
                  },
                  {
                    id: "models",
                    label: "Models",
                    icon: <Sparkles size={16} />,
                  },
                ]}
                activeSection={activeSection}
                onSelect={handleSectionSelect}
              />
              <SettingsNavSection
                label="Coding"
                items={[
                  { id: "hooks", label: "Hooks", icon: <Cable size={16} /> },
                ]}
                activeSection={activeSection}
                onSelect={handleSectionSelect}
              />
            </nav>
          </aside>

          <section className="relative z-10 flex min-w-0 flex-1 flex-col">
            <header className="flex items-center justify-between border-b ui-muted-divider px-6 py-4">
              <h2
                id="settings-dialog-title"
                className="text-xl font-semibold tracking-tight text-zinc-100"
              >
                {activeSection === "general"
                  ? "General"
                  : activeSection === "archived"
                    ? "Archived"
                    : activeSection === "connect"
                      ? "Providers"
                      : activeSection === "models"
                        ? "Models"
                        : "Hooks"}
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-200"
                aria-label="Close settings"
              >
                <X size={16} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
              {status === "error" && error ? (
                <div className="mb-5 rounded-lg border border-red-800/80 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              ) : null}

              {activeSection === "general" ? <SettingsGeneralPanel /> : null}

              {activeSection === "archived" ? (
                <ArchivedChatsSettings
                  isActive={activeSection === "archived"}
                  onUnarchiveSession={onUnarchiveSession}
                />
              ) : null}

              {activeSection === "connect" ? (
                <SettingsConnectPanel
                  connectView={connectView}
                  connectError={connectError}
                  connectSuccess={connectSuccess}
                  catalog={catalog}
                  connectedProviders={connectedProviders}
                  disconnectingCredentialId={disconnectingCredentialId}
                  availableProviders={availableProviders}
                  isConnecting={isConnecting}
                  selectedProviderIdForConnect={selectedProviderIdForConnect}
                  onOpenConnectView={openConnectView}
                  onBackToOverview={handleBackToConnectOverview}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                  onClearConnectError={() => setConnectError(null)}
                />
              ) : null}

              {activeSection === "models" ? (
                <SettingsModelsPanel
                  catalog={catalog}
                  credentials={credentials}
                  providerModels={manageProviderModels}
                  visibleModelIds={visibleModelIds}
                  loadingProviderModelIds={loadingManageModelsForProviderIds}
                  onLoadProviderModels={loadManageProviderModels}
                  onToggleModelVisibility={toggleModelVisibility}
                  onSetProviderVisibleModels={setProviderVisibleModels}
                />
              ) : null}

              {activeSection === "hooks" ? (
                <HooksSettingsPanel
                  isActive={activeSection === "hooks"}
                  workspaceId={workspaceId}
                  audits={hookAudits}
                />
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {disconnectToasts.length > 0 ? (
        <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
          {disconnectToasts.map((toast) => (
            <div
              key={toast.id}
              className="ui-surface-popover pointer-events-auto px-4 py-3 text-zinc-100"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 text-zinc-300" size={16} />
                  <div>
                    <p className="text-sm font-medium leading-tight">
                      {toast.providerName} disconnected
                    </p>
                    <p className="mt-1 text-sm text-zinc-300">
                      {toast.providerName} models are no longer available.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => dismissDisconnectToast(toast.id)}
                  className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
                  aria-label="Dismiss notification"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function SettingsNavSection({
  label,
  items,
  activeSection,
  onSelect,
}: {
  label: string;
  items: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }>;
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}): React.ReactElement {
  return (
    <div>
      <p className="mb-1 text-sm text-zinc-500">{label}</p>
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition ${
              activeSection === item.id
                ? "bg-zinc-800/90 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200"
            }`}
          >
            <span className="text-zinc-500">{item.icon}</span>
            <span className="text-sm font-medium leading-none">
              {item.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingsGeneralPanel(): React.ReactElement {
  const composerPreferences = useComposerPreferences();

  return (
    <div className="space-y-4">
      <SettingCard
        title="Theme"
        description="LegionCode currently ships a single dark theme tuned for terminal-first workflows."
        right="Dark"
      />
      <SettingCard
        title="Keyboard Navigation"
        description="Global shortcuts and command palette settings are managed in the desktop shell."
        right="Default"
      />
      <SettingCard
        title="Run Isolation"
        description="Provider selection and model visibility remain scoped to your active run context."
        right="Enabled"
      />
      <div className="ui-surface-section px-5 py-4">
        <div className="mb-4">
          <p className="text-sm font-medium text-zinc-100">Composer</p>
          <p className="mt-1 text-sm text-zinc-400">
            Choose which runtime-reported information appears beside the model.
          </p>
        </div>
        <label className="flex cursor-pointer items-center justify-between gap-4 border-t border-zinc-800 pt-4">
          <span>
            <span className="block text-sm font-medium text-zinc-100">
              Show context window usage
            </span>
            <span className="mt-1 block text-xs text-zinc-500">
              Display the context ring and open the canonical context details
              panel.
            </span>
          </span>
          <Switch
            label="Show context window usage"
            checked={composerPreferences.showContextWindowUsage}
            onCheckedChange={(checked) =>
              updateComposerPreferences({
                showContextWindowUsage: checked,
              })
            }
          />
        </label>
      </div>
    </div>
  );
}

function SettingCard({
  title,
  description,
  right,
}: {
  title: string;
  description: string;
  right: string;
}): React.ReactElement {
  return (
    <div className="ui-surface-section px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-zinc-100">{title}</p>
          <p className="mt-1 text-sm text-zinc-400">{description}</p>
        </div>
        <span className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300">
          {right}
        </span>
      </div>
    </div>
  );
}

function SettingsConnectPanel({
  connectView,
  connectError,
  connectSuccess,
  catalog,
  connectedProviders,
  disconnectingCredentialId,
  availableProviders,
  isConnecting,
  selectedProviderIdForConnect,
  onOpenConnectView,
  onBackToOverview,
  onConnect,
  onDisconnect,
  onClearConnectError,
}: {
  connectView: ConnectView;
  connectError: string | null;
  connectSuccess: string | null;
  catalog: ProviderRegistryEntry[];
  connectedProviders: ConnectedProviderRow[];
  disconnectingCredentialId: string | null;
  availableProviders: ProviderRegistryEntry[];
  isConnecting: boolean;
  selectedProviderIdForConnect: string | null;
  onOpenConnectView: (providerId?: string) => void;
  onBackToOverview: () => void;
  onConnect: (
    providerId: string,
    secret: string,
    label?: string,
  ) => Promise<void>;
  onDisconnect: (
    credential: BYOKCredential,
    providerName: string,
  ) => Promise<void>;
  onClearConnectError: () => void;
}): React.ReactElement {
  if (connectView === "connect") {
    return (
      <div className="ui-surface-section p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-zinc-100">
            Connect Provider
          </h3>
          <button
            type="button"
            onClick={onBackToOverview}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800"
          >
            Back
          </button>
        </div>
        <ConnectProviderChooser
          key={selectedProviderIdForConnect ?? "provider-list"}
          catalog={catalog}
          error={connectError}
          success={connectSuccess}
          isConnecting={isConnecting}
          presentation="plain"
          showTitle={false}
          initialSelectedProviderId={selectedProviderIdForConnect ?? undefined}
          onConnect={onConnect}
          onErrorClear={onClearConnectError}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-4 text-base font-semibold text-zinc-100">
          Connected providers
        </h3>
        <div className="ui-surface-section">
          {connectedProviders.length === 0 ? (
            <div className="px-4 py-6 text-sm text-zinc-400">
              No provider keys connected yet.
            </div>
          ) : (
            connectedProviders.map((provider, index) => (
              <div
                key={provider.providerId}
                className={`flex min-h-20 items-center justify-between gap-4 px-5 py-4 ${
                  index > 0 ? "border-t border-zinc-800/70" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderIcon providerId={provider.providerId} />
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-zinc-100">
                      {provider.displayName}
                    </p>
                    <span className="rounded border border-zinc-700 bg-zinc-800/70 px-1.5 py-0.5 text-xs text-zinc-400">
                      API key
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onDisconnect(provider.credential, provider.displayName)
                  }
                  disabled={
                    disconnectingCredentialId ===
                    provider.credential.credentialId
                  }
                  className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {disconnectingCredentialId ===
                  provider.credential.credentialId
                    ? "Disconnecting..."
                    : "Disconnect"}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-4 text-base font-semibold text-zinc-100">
          Popular providers
        </h3>
        <div className="ui-surface-section">
          {availableProviders.length === 0 ? (
            <div className="px-4 py-6 text-sm text-zinc-400">
              All available providers are already connected.
            </div>
          ) : (
            availableProviders.map((provider, index) => (
              <div
                key={provider.providerId}
                className={`flex min-h-20 items-center justify-between gap-4 px-5 py-4 ${
                  index > 0 ? "border-t border-zinc-800/70" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderIcon providerId={provider.providerId} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">
                      {provider.displayName}
                    </p>
                    <p className="mt-1 truncate text-sm text-zinc-500">
                      {provider.keyFormat?.description ??
                        "Connect using your API key"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenConnectView(provider.providerId)}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 transition hover:bg-zinc-800"
                >
                  <Plus size={14} />
                  Connect
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function SettingsModelsPanel({
  catalog,
  credentials,
  providerModels,
  visibleModelIds,
  loadingProviderModelIds,
  onLoadProviderModels,
  onToggleModelVisibility,
  onSetProviderVisibleModels,
}: {
  catalog: ProviderRegistryEntry[];
  credentials: BYOKCredential[];
  providerModels: Record<string, ProviderModelOption[]>;
  visibleModelIds: Record<string, Set<string>>;
  loadingProviderModelIds: Record<string, boolean>;
  onLoadProviderModels: (
    providerId: string,
    limit?: number,
  ) => Promise<ProviderModelOption[]>;
  onToggleModelVisibility: (providerId: string, modelId: string) => void;
  onSetProviderVisibleModels: (providerId: string, modelIds: string[]) => void;
}): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedProviderIds, setExpandedProviderIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const connectedProviderIds = new Set(
      credentials.map((credential) => credential.providerId),
    );

    void Promise.allSettled(
      catalog
        .filter((entry) => connectedProviderIds.has(entry.providerId))
        .map((entry) => onLoadProviderModels(entry.providerId, 150)),
    );
  }, [catalog, credentials, onLoadProviderModels]);

  const providerGroups = useMemo(
    () =>
      buildProviderGroupsForModels(
        catalog,
        credentials,
        providerModels,
        loadingProviderModelIds,
      ),
    [catalog, credentials, loadingProviderModelIds, providerModels],
  );

  const filteredGroups = useMemo(
    () => filterModelProviderGroups(providerGroups, searchQuery),
    [providerGroups, searchQuery],
  );

  const toggleExpanded = (providerId: string): void => {
    setExpandedProviderIds((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
          aria-hidden="true"
        />
        <input
          type="text"
          placeholder="Search models"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="ui-input h-11 w-full pl-10 pr-3 text-sm"
        />
      </div>

      {filteredGroups.length === 0 ? (
        <div className="ui-surface-section px-4 py-8 text-center text-sm text-zinc-400">
          {searchQuery
            ? "No models match your search"
            : "No providers connected"}
        </div>
      ) : (
        <div className="space-y-1">
          {filteredGroups.map((group) => {
            const visibleSet = visibleModelIds[group.providerId];
            const filteredModels = group.filteredModels;
            const isExpanded =
              searchQuery.trim().length > 0 ||
              expandedProviderIds.has(group.providerId);
            const isProviderVisible = visibleSet
              ? visibleSet.size > 0
              : group.models.length > 0;
            const canToggleProviderVisibility = group.models.length > 0;

            return (
              <section key={group.providerId}>
                <div className="flex min-h-14 items-center gap-3 rounded-lg px-3 transition hover:bg-zinc-800/55">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(group.providerId)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    aria-expanded={isExpanded}
                  >
                    <ChevronRight
                      size={14}
                      className={`shrink-0 text-zinc-600 transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    />
                    <ProviderIcon providerId={group.providerId} />
                    <span className="truncate text-sm font-medium text-zinc-100">
                      {group.displayName}
                    </span>
                    <span className="text-xs text-zinc-600">
                      {group.isModelListLoaded
                        ? `${group.models.length} models`
                        : "Loading"}
                    </span>
                  </button>
                  <Switch
                    label={`Show ${group.displayName} models`}
                    disabled={!canToggleProviderVisibility}
                    checked={isProviderVisible}
                    onCheckedChange={() => {
                      if (isProviderVisible) {
                        onSetProviderVisibleModels(group.providerId, []);
                      } else {
                        onSetProviderVisibleModels(
                          group.providerId,
                          group.models.map((model) => model.id),
                        );
                      }
                    }}
                  />
                </div>

                {isExpanded && !group.isModelListLoaded ? (
                  <div className="ml-10 px-4 py-4 text-sm text-zinc-500">
                    Loading models...
                  </div>
                ) : isExpanded && filteredModels.length === 0 ? (
                  <div className="ml-10 px-4 py-4 text-sm text-zinc-500">
                    {searchQuery
                      ? "No models match your search"
                      : "No models available"}
                  </div>
                ) : isExpanded ? (
                  <div className="ui-surface-section ml-10 overflow-hidden">
                    {filteredModels.map((model, index) => {
                      const enabled = visibleSet
                        ? visibleSet.has(model.id)
                        : true;

                      return (
                        <label
                          key={model.id}
                          className={`flex min-h-16 items-center justify-between gap-3 px-5 py-3 ${
                            index > 0 ? "border-t border-zinc-800/50" : ""
                          }`}
                        >
                          <p className="text-sm font-medium text-zinc-200">
                            {formatModelDisplayName(model)}
                          </p>
                          <Switch
                            label={`Show ${formatModelDisplayName(model)}`}
                            checked={enabled}
                            onCheckedChange={() =>
                              onToggleModelVisibility(
                                group.providerId,
                                model.id,
                              )
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ProviderGroup {
  providerId: string;
  displayName: string;
  models: ProviderModelOption[];
  isModelListLoaded: boolean;
}

interface FilteredProviderGroup extends ProviderGroup {
  filteredModels: ProviderModelOption[];
}

function buildConnectedProviderRows(
  catalog: ProviderRegistryEntry[],
  credentials: BYOKCredential[],
): ConnectedProviderRow[] {
  const catalogById = new Map(
    catalog.map((entry) => [entry.providerId, entry]),
  );
  const firstCredentialByProvider = new Map<string, BYOKCredential>();

  for (const credential of credentials) {
    if (!firstCredentialByProvider.has(credential.providerId)) {
      firstCredentialByProvider.set(credential.providerId, credential);
    }
  }

  const rows: ConnectedProviderRow[] = [];

  for (const [providerId, credential] of firstCredentialByProvider.entries()) {
    const entry = catalogById.get(providerId);
    rows.push({
      providerId,
      displayName: entry?.displayName ?? providerId,
      credential,
    });
  }

  return rows.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function sortProviderModels(
  providerId: string,
  models: ProviderModelOption[],
): ProviderModelOption[] {
  if (providerId !== "openrouter") {
    return [...models].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  return [...models].sort((left, right) => {
    const [leftAuthor] = left.id.split("/");
    const [rightAuthor] = right.id.split("/");
    const authorCompare = (leftAuthor ?? "").localeCompare(rightAuthor ?? "");
    if (authorCompare !== 0) {
      return authorCompare;
    }
    return left.name.localeCompare(right.name);
  });
}

function buildProviderGroupsForModels(
  catalog: ProviderRegistryEntry[],
  credentials: BYOKCredential[],
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
    .map((entry) => ({
      providerId: entry.providerId,
      displayName: entry.displayName,
      models: sortProviderModels(
        entry.providerId,
        providerModels[entry.providerId] ?? [],
      ),
      isModelListLoaded:
        Object.prototype.hasOwnProperty.call(
          providerModels,
          entry.providerId,
        ) && !loadingProviderModelIds[entry.providerId],
    }));
}

function filterModelProviderGroups(
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
      filteredModels: group.models.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.id.toLowerCase().includes(query) ||
          group.displayName.toLowerCase().includes(query),
      ),
    }))
    .filter(
      (group) =>
        group.filteredModels.length > 0 ||
        group.displayName.toLowerCase().includes(query),
    );
}
