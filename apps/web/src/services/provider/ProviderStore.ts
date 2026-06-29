/**
 * Provider Store - Centralized State Management
 *
 * Single source of truth for provider credentials, preferences, and resolution.
 * Provides typed interface for all provider operations with built-in error handling and caching.
 *
 * Usage:
 *   const store = ProviderStore.getInstance();
 *   await store.bootstrap();
 *   const { credentials, preferences } = store.getState();
 */

import {
  BYOKResolution as ProviderResolution,
  BYOKCredential as ProviderCredential,
  BYOKPreference as ProviderPreference,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKPreferencesUpdateRequest,
  type BYOKResolveRequest,
  ProviderRegistryEntry,
  canPreloadProvider,
  canShowProviderInPrimaryUi,
} from "@repo/shared-types";
import {
  ProviderApiClient,
  type ProviderModelDiscoveryView,
  type ProviderModelOption,
  type ProviderModelsPageResult,
  type ProviderModelsQuery,
} from "../api/providerClient.js";
import { resolveWebProviderProductPolicy } from "../../lib/provider-product-policy";

const WEB_PROVIDER_POLICY = resolveWebProviderProductPolicy();

export interface ProviderModelsMetadataState {
  fetchedAt: string;
  stale: boolean;
  source: "provider_api" | "cache";
  staleReason?: string;
}

export interface ProviderModelsPageState {
  view: ProviderModelDiscoveryView;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ProviderAxisQuotaState {
  used: number;
  limit: number;
  resetsAt: string;
}

/**
 * Store state shape
 */
export interface ProviderStoreState {
  // Data
  catalog: ProviderRegistryEntry[];
  credentials: ProviderCredential[];
  preferences: ProviderPreference | null;
  providerModels: Record<string, ProviderModelOption[]>;
  manageProviderModels: Record<string, ProviderModelOption[]>;
  providerModelsMetadata: Record<string, ProviderModelsMetadataState>;
  providerModelsPage: Record<string, ProviderModelsPageState>;
  visibleModelIds: Record<string, Set<string>>;

  // Current selection
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;

  // Computed
  lastResolvedConfig: ProviderResolution | null;
  axisQuota?: ProviderAxisQuotaState | null;

  // Status tracking
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isValidating: boolean;
  loadingModelsForProviderId: string | null;
  loadingManageModelsForProviderIds: Record<string, boolean>;
  selectedModelView: ProviderModelDiscoveryView;
  refreshingModelsForProviderId: string | null;
}

type ProviderWorkspaceGlobalState = Pick<
  ProviderStoreState,
  | "catalog"
  | "credentials"
  | "preferences"
  | "providerModels"
  | "manageProviderModels"
  | "providerModelsMetadata"
  | "providerModelsPage"
  | "visibleModelIds"
>;

type ProviderRunScopedState = Pick<
  ProviderStoreState,
  | "selectedProviderId"
  | "selectedCredentialId"
  | "selectedModelId"
  | "lastResolvedConfig"
  | "axisQuota"
>;

type ProviderOperationalState = Pick<
  ProviderStoreState,
  | "status"
  | "error"
  | "isValidating"
  | "loadingModelsForProviderId"
  | "loadingManageModelsForProviderIds"
  | "selectedModelView"
  | "refreshingModelsForProviderId"
>;

interface ProviderSelectionSnapshot {
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;
}

type InflightScope = "workspace" | "run";

interface InflightRequest {
  promise: Promise<unknown>;
  scope: InflightScope;
}

const RUN_SCOPED_SELECTION_STORAGE_KEY_PREFIX =
  "provider:run-scoped-selection:";

export type ConnectCredentialRequest = BYOKCredentialConnectRequest;
export type ValidateCredentialRequest = BYOKCredentialValidateRequest;

/**
 * API client contract for store operations.
 * Keeps store testable and decoupled from concrete client implementation.
 */
export interface ProviderApiClientContract {
  getCatalog(): Promise<ProviderRegistryEntry[]>;
  getProviderModels(
    providerId: string,
    query?: ProviderModelsQuery,
  ): Promise<ProviderModelsPageResult>;
  refreshProviderModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse>;
  getCredentials(): Promise<ProviderCredential[]>;
  getPreferences(): Promise<ProviderPreference>;
  connectCredential(req: ConnectCredentialRequest): Promise<ProviderCredential>;
  disconnectCredential(credentialId: string): Promise<void>;
  validateCredential(
    credentialId: string,
    req: ValidateCredentialRequest,
  ): Promise<BYOKCredentialValidateResponse>;
  updatePreferences(
    req: BYOKPreferencesUpdateRequest,
  ): Promise<ProviderPreference>;
  resolveForChat(req: BYOKResolveRequest): Promise<ProviderResolution>;
}

export interface SessionSelectionRequest {
  providerId: string;
  credentialId: string;
  modelId?: string;
}

export interface LoadProviderModelsOptions {
  view?: ProviderModelDiscoveryView;
  cursor?: string;
  surface?: "picker" | "manage";
  limit?: number;
  append?: boolean;
}

interface ResolvedLoadProviderModelsOptions {
  view: ProviderModelDiscoveryView;
  cursor?: string;
  surface: "picker" | "manage";
  limit: number;
  append: boolean;
}

/**
 * Store initialization options
 */
export interface ProviderStoreOptions {
  apiClient?: ProviderApiClientContract;
  enableLogging?: boolean;
}

/**
 * ProviderStore - Manages all provider state and operations
 */
export class ProviderStore {
  private static instance: ProviderStore;
  private state: ProviderStoreState;
  private activeRunId: string | null = null;
  private apiClient: ProviderApiClientContract;
  private listeners: Set<(state: ProviderStoreState) => void> = new Set();
  private inflight: Map<string, InflightRequest> = new Map();
  private bootstrapPromise: Promise<void> | null = null;
  private lastResolveSelectionKey: string | null = null;
  private lastResolveError: Error | null = null;
  private workspaceEpoch = 0;
  private runScopeEpoch = 0;
  private enableLogging: boolean;

  private constructor(
    apiClient: ProviderApiClientContract,
    enableLogging = false,
  ) {
    this.apiClient = apiClient;
    this.enableLogging = enableLogging;
    this.state = createInitialStoreState();
  }

  /**
   * Get or create singleton instance
   */
  static getInstance(options?: ProviderStoreOptions): ProviderStore {
    if (!ProviderStore.instance) {
      const apiClient = options?.apiClient || new ProviderApiClient();
      ProviderStore.instance = new ProviderStore(
        apiClient,
        options?.enableLogging ?? false,
      );
    }
    return ProviderStore.instance;
  }

  /**
   * Bind store state to active run scope.
   * Resets run-scoped state when run changes to prevent cross-run leakage.
   * Returns true if bootstrap should be called.
   */
  setActiveRunId(runId: string): boolean {
    if (!runId) {
      return false;
    }

    if (this.activeRunId === runId) {
      if (this.state.status === "idle") {
        this.restoreRunScopedSelection(runId);
      }
      return this.state.status === "idle";
    }

    const previousRunId = this.activeRunId;
    const didSwitchRun = previousRunId !== null && previousRunId !== runId;
    const carryForwardSelection = didSwitchRun
      ? this.captureRunScopedSelectionSnapshot()
      : null;
    this.activeRunId = runId;

    if (didSwitchRun) {
      this.log("[run] switched active run, resetting run-scoped state", {
        previousRunId,
        nextRunId: runId,
      });
      this.resetRunScope();
    }

    const restoredRunScopedSelection = this.restoreRunScopedSelection(runId);
    if (hasWorkspaceGlobalState(this.state)) {
      this.hydrateRunScopedSelectionFromWorkspaceState(
        !restoredRunScopedSelection ? carryForwardSelection : null,
      );
      return false;
    }

    return true;
  }

  /**
   * Get current state with deep-copied visibleModelIds to prevent mutations
   */
  getState(): ProviderStoreState {
    return {
      ...this.state,
      visibleModelIds: this.copyVisibleModelIds(this.state.visibleModelIds),
    };
  }

  /**
   * Deep copy visibleModelIds to prevent external mutations
   */
  private copyVisibleModelIds(
    visibleModelIds: Record<string, Set<string>>,
  ): Record<string, Set<string>> {
    const copy: Record<string, Set<string>> = {};
    for (const [providerId, modelSet] of Object.entries(visibleModelIds)) {
      copy[providerId] = new Set(modelSet);
    }
    return copy;
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: ProviderStoreState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Bootstrap store: fetch catalog, credentials, preferences
   */
  async bootstrap(): Promise<void> {
    this.log("[bootstrap] Starting");

    if (this.bootstrapPromise) {
      this.log("[bootstrap] Request already in flight");
      await this.bootstrapPromise;
      return;
    }

    const epoch = this.workspaceEpoch;
    const promise = this.executeBootstrap(epoch);
    this.bootstrapPromise = promise;
    try {
      await promise;
    } finally {
      if (this.bootstrapPromise === promise) {
        this.bootstrapPromise = null;
      }
    }
  }

  private async executeBootstrap(epoch: number): Promise<void> {
    this.setState({ status: "loading", error: null });
    try {
      const [rawCatalog, credentials, preferences] = await Promise.all([
        this.apiClient.getCatalog(),
        this.apiClient.getCredentials(),
        this.apiClient.getPreferences(),
      ]);
      const catalog = rawCatalog.filter((entry) =>
        canShowProviderInPrimaryUi(WEB_PROVIDER_POLICY, entry.providerId),
      );
      if (this.isWorkspaceEpochStale("bootstrap", epoch)) {
        return;
      }
      const visibleModelIds = this.hydrateVisibleModelIds(preferences);
      const selection = this.deriveSelectionSnapshot({
        catalog,
        credentials,
        preferences,
        providerModels: this.state.providerModels,
        visibleModelIds,
        selectedProviderId: this.state.selectedProviderId,
        selectedCredentialId: this.state.selectedCredentialId,
        selectedModelId: this.state.selectedModelId,
      });

      this.setState({
        catalog,
        credentials,
        preferences,
        visibleModelIds,
        selectedProviderId: selection.selectedProviderId,
        selectedCredentialId: selection.selectedCredentialId,
        selectedModelId: selection.selectedModelId,
        status: "ready",
      });

      const preloadProviderIds = this.collectBootstrapModelPreloadProviderIds(
        catalog,
        credentials,
      );
      for (const providerId of preloadProviderIds) {
        if (this.state.providerModels[providerId]) {
          continue;
        }
        void this.loadProviderModels(providerId).catch((error) => {
          this.log("[bootstrap] model preload failed", {
            providerId,
            error,
          });
        });
      }

      this.log("[bootstrap] Success", {
        providers: catalog.length,
        credentials: credentials.length,
      });
    } catch (error) {
      if (this.isWorkspaceEpochStale("bootstrap", epoch)) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : "Failed to bootstrap provider state";
      this.setState({
        status: "error",
        error: message,
      });
      this.log("[bootstrap] Error", { error: message });
      throw error;
    }
  }

  /**
   * Hydrate visibility state from persisted preferences
   * - If provider is in preferences with models: show only those models
   * - If provider is in preferences with empty array: show no models
   * - If provider is not in preferences: show all models (default)
   */
  private hydrateVisibleModelIds(
    preferences: ProviderPreference | null,
  ): Record<string, Set<string>> {
    const result: Record<string, Set<string>> = {};

    if (!preferences?.visibleModelIds) {
      return result;
    }

    // Convert arrays from preference to Sets
    for (const [providerId, modelIds] of Object.entries(
      preferences.visibleModelIds,
    )) {
      // Empty array = no models visible, non-empty = only those models visible
      result[providerId] = new Set(modelIds);
    }

    return result;
  }

  private seedHiddenVisibilityForNewProvider(
    preferences: ProviderPreference,
    providerId: string,
    hasExistingCredential: boolean,
  ): Record<string, Set<string>> | null {
    if (hasExistingCredential) {
      return null;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        preferences.visibleModelIds,
        providerId,
      )
    ) {
      return null;
    }

    return {
      ...this.copyVisibleModelIds(this.state.visibleModelIds),
      [providerId]: new Set<string>(),
    };
  }

  /**
   * Connect a new credential
   */
  async connectCredential(req: ConnectCredentialRequest): Promise<void> {
    const key = `connect:${req.providerId}`;

    if (this.inflight.has(key)) {
      this.log("[connectCredential] Request already in flight");
      await this.inflight.get(key)?.promise;
      return;
    }

    const promise = this.executeConnect(req);
    this.trackInflight(key, promise, "workspace");

    try {
      await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Internal connect implementation
   */
  private async executeConnect(req: ConnectCredentialRequest): Promise<void> {
    this.log("[connectCredential] Starting", { providerId: req.providerId });
    const epoch = this.workspaceEpoch;

    try {
      const credential = await this.apiClient.connectCredential(req);
      let preferences = await this.apiClient.getPreferences();
      if (this.isWorkspaceEpochStale("connectCredential", epoch)) {
        return;
      }

      let providerModels = this.state.providerModels;
      const hasExistingCredential = this.state.credentials.some(
        (existing) => existing.providerId === req.providerId,
      );
      try {
        const models = await this.loadProviderModels(req.providerId);
        if (this.isWorkspaceEpochStale("connectCredential", epoch)) {
          return;
        }
        providerModels = {
          ...providerModels,
          [req.providerId]: models,
        };
      } catch (error) {
        this.log("[connectCredential] model preload failed", { error });
      }

      const nextVisibleModelIds = this.seedHiddenVisibilityForNewProvider(
        preferences,
        req.providerId,
        hasExistingCredential,
      );
      if (nextVisibleModelIds) {
        preferences = {
          ...preferences,
          visibleModelIds: serializeVisibleModelIds(nextVisibleModelIds),
        };
      }

      const defaultModelId =
        (preferences.defaultProviderId === req.providerId
          ? preferences.defaultModelId
          : undefined) ??
        providerModels[req.providerId]?.[0]?.id ??
        this.state.catalog.find((p) => p.providerId === req.providerId)
          ?.defaultModelId ??
        null;
      const currentCredentialIndex = this.state.credentials.findIndex(
        (existing) => existing.credentialId === credential.credentialId,
      );
      const nextCredentials =
        currentCredentialIndex === -1
          ? [...this.state.credentials, credential]
          : this.state.credentials.map((existing) =>
              existing.credentialId === credential.credentialId
                ? credential
                : existing,
            );
      const selection = this.deriveSelectionSnapshot({
        catalog: this.state.catalog,
        credentials: nextCredentials,
        preferences,
        providerModels,
        visibleModelIds: nextVisibleModelIds ?? this.state.visibleModelIds,
        selectedProviderId: this.state.selectedProviderId ?? req.providerId,
        selectedCredentialId:
          this.state.selectedCredentialId ?? credential.credentialId,
        selectedModelId: this.state.selectedModelId ?? defaultModelId,
      });

      this.setState({
        credentials: nextCredentials,
        preferences,
        ...(nextVisibleModelIds
          ? { visibleModelIds: nextVisibleModelIds }
          : undefined),
        providerModels,
        selectedProviderId: selection.selectedProviderId,
        selectedCredentialId: selection.selectedCredentialId,
        selectedModelId: selection.selectedModelId,
      });

      if (nextVisibleModelIds) {
        void this.persistVisibilityChanges(nextVisibleModelIds).catch(
          (error) => {
            this.log(
              "[connectCredential] failed to persist hidden model defaults",
              {
                providerId: req.providerId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          },
        );
      }

      this.log("[connectCredential] Success", {
        credentialId: credential.credentialId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to connect credential";
      this.log("[connectCredential] Error", { error: message });
      throw error;
    }
  }

  /**
   * Disconnect a credential
   */
  async disconnectCredential(credentialId: string): Promise<void> {
    const key = `disconnect:${credentialId}`;

    if (this.inflight.has(key)) {
      this.log("[disconnectCredential] Request already in flight");
      await this.inflight.get(key)?.promise;
      return;
    }

    const promise = this.executeDisconnect(credentialId);
    this.trackInflight(key, promise, "workspace");

    try {
      await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Internal disconnect implementation
   */
  private async executeDisconnect(credentialId: string): Promise<void> {
    this.log("[disconnectCredential] Starting", { credentialId });
    const epoch = this.workspaceEpoch;

    try {
      await this.apiClient.disconnectCredential(credentialId);
      if (this.isWorkspaceEpochStale("disconnectCredential", epoch)) {
        return;
      }

      // Remove from credentials list
      const nextCredentials = this.state.credentials.filter(
        (credential) => credential.credentialId !== credentialId,
      );
      const selection = this.deriveSelectionSnapshot({
        catalog: this.state.catalog,
        credentials: nextCredentials,
        preferences: this.state.preferences,
        providerModels: this.state.providerModels,
        visibleModelIds: this.state.visibleModelIds,
        selectedProviderId: this.state.selectedProviderId,
        selectedCredentialId:
          this.state.selectedCredentialId === credentialId
            ? null
            : this.state.selectedCredentialId,
        selectedModelId: this.state.selectedModelId,
      });
      this.setState({
        credentials: nextCredentials,
        selectedProviderId: selection.selectedProviderId,
        selectedCredentialId: selection.selectedCredentialId,
        selectedModelId: selection.selectedModelId,
      });

      this.log("[disconnectCredential] Success", { credentialId });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to disconnect credential";
      this.log("[disconnectCredential] Error", { error: message });
      throw error;
    }
  }

  /**
   * Validate a credential (format or live)
   */
  async validateCredential(
    credentialId: string,
    mode: "format" | "live",
  ): Promise<void> {
    const key = `validate:${credentialId}:${mode}`;

    if (this.inflight.has(key)) {
      this.log("[validateCredential] Request already in flight");
      await this.inflight.get(key)?.promise;
      return;
    }

    this.setState({ isValidating: true });

    const promise = this.executeValidate(credentialId, mode);
    this.trackInflight(key, promise, "workspace");

    try {
      await promise;
    } finally {
      this.inflight.delete(key);
      this.setState({ isValidating: false });
    }
  }

  /**
   * Internal validate implementation
   */
  private async executeValidate(
    credentialId: string,
    mode: "format" | "live",
  ): Promise<void> {
    this.log("[validateCredential] Starting", { credentialId, mode });
    const epoch = this.workspaceEpoch;

    try {
      await this.apiClient.validateCredential(credentialId, { mode });
      if (this.isWorkspaceEpochStale("validateCredential", epoch)) {
        return;
      }

      // Update credential status if validation succeeded
      const credential = this.state.credentials.find(
        (c) => c.credentialId === credentialId,
      );
      if (credential) {
        const updated = { ...credential, status: "connected" as const };
        this.setState({
          credentials: this.state.credentials.map((c) =>
            c.credentialId === credentialId ? updated : c,
          ),
        });
      }

      this.log("[validateCredential] Success", { credentialId, mode });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Validation failed";
      this.log("[validateCredential] Error", { error: message });
      throw error;
    }
  }

  /**
   * Update workspace preferences
   */
  async updatePreferences(
    partial: BYOKPreferencesUpdateRequest,
  ): Promise<void> {
    const key = "preferences";

    if (this.inflight.has(key)) {
      this.log("[updatePreferences] Request already in flight");
      await this.inflight.get(key)?.promise;
      return;
    }

    const promise = this.executeUpdatePreferences(partial);
    this.trackInflight(key, promise, "workspace");

    try {
      await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  async loadProviderModels(
    providerId: string,
    options: LoadProviderModelsOptions = {},
  ): Promise<ProviderModelOption[]> {
    const resolvedOptions = this.resolveLoadOptions(providerId, options);
    const key = [
      "models",
      providerId,
      resolvedOptions.view,
      resolvedOptions.cursor ?? "start",
      resolvedOptions.append ? "append" : "replace",
      resolvedOptions.limit,
    ].join(":");

    if (this.inflight.has(key)) {
      this.log("[loadProviderModels] Request already in flight", {
        providerId,
        ...resolvedOptions,
      });
      return (await this.inflight.get(key)?.promise) as ProviderModelOption[];
    }

    this.setState({ loadingModelsForProviderId: providerId });
    const promise = this.executeLoadProviderModels(
      providerId,
      resolvedOptions,
      this.workspaceEpoch,
    );
    this.trackInflight(key, promise, "workspace");

    try {
      return (await promise) as ProviderModelOption[];
    } finally {
      this.inflight.delete(key);
      if (this.state.loadingModelsForProviderId === providerId) {
        this.setState({ loadingModelsForProviderId: null });
      }
    }
  }

  async loadManageProviderModels(
    providerId: string,
    limit = 150,
  ): Promise<ProviderModelOption[]> {
    const key = ["manage-models", providerId, limit].join(":");
    if (this.inflight.has(key)) {
      return (await this.inflight.get(key)?.promise) as ProviderModelOption[];
    }

    this.setState({
      loadingManageModelsForProviderIds: {
        ...this.state.loadingManageModelsForProviderIds,
        [providerId]: true,
      },
    });

    const promise = this.executeLoadManageProviderModels(
      providerId,
      limit,
      this.workspaceEpoch,
    );
    this.trackInflight(key, promise, "workspace");

    try {
      return (await promise) as ProviderModelOption[];
    } finally {
      this.inflight.delete(key);
      this.setState({
        loadingManageModelsForProviderIds: {
          ...this.state.loadingManageModelsForProviderIds,
          [providerId]: false,
        },
      });
    }
  }

  async loadMoreProviderModels(
    providerId: string,
  ): Promise<ProviderModelOption[]> {
    const pageState = this.state.providerModelsPage[providerId];
    if (!pageState?.hasMore || !pageState.nextCursor) {
      return this.state.providerModels[providerId] ?? [];
    }
    return this.loadProviderModels(providerId, {
      view: pageState.view,
      cursor: pageState.nextCursor,
      append: true,
    });
  }

  async refreshProviderModels(providerId: string): Promise<void> {
    const key = `refresh-models:${providerId}`;
    if (this.inflight.has(key)) {
      await this.inflight.get(key)?.promise;
      return;
    }

    this.setState({ refreshingModelsForProviderId: providerId });
    const promise = this.executeRefreshProviderModels(
      providerId,
      this.workspaceEpoch,
    );
    this.trackInflight(key, promise, "workspace");
    try {
      await promise;
    } finally {
      this.inflight.delete(key);
      if (this.state.refreshingModelsForProviderId === providerId) {
        this.setState({ refreshingModelsForProviderId: null });
      }
    }
  }

  async setModelView(view: ProviderModelDiscoveryView): Promise<void> {
    if (this.state.selectedModelView === view) {
      return;
    }
    this.setState({ selectedModelView: view });
    if (!this.state.selectedProviderId) {
      return;
    }
    await this.loadProviderModels(this.state.selectedProviderId, {
      view,
      append: false,
    });
  }

  private async executeLoadProviderModels(
    providerId: string,
    options: ResolvedLoadProviderModelsOptions,
    epoch: number,
  ): Promise<ProviderModelOption[]> {
    this.log("[loadProviderModels] Starting", { providerId, ...options });
    try {
      const result = await this.apiClient.getProviderModels(providerId, {
        view: options.view,
        surface: options.surface,
        limit: options.limit,
        cursor: options.cursor,
      });
      if (this.isWorkspaceEpochStale("loadProviderModels", epoch)) {
        return result.models;
      }

      const currentModels = this.state.providerModels[providerId] ?? [];
      const mergedModels = options.append
        ? mergeModelsById(currentModels, result.models)
        : result.models;
      const pickerModels = this.syncPickerModelsWithVisibleManagedModels(
        providerId,
        mergedModels,
        this.state.visibleModelIds,
      );

      this.setState({
        providerModels: {
          ...this.state.providerModels,
          [providerId]: pickerModels,
        },
        providerModelsPage: {
          ...this.state.providerModelsPage,
          [providerId]: {
            view: result.view,
            hasMore: result.page.hasMore,
            nextCursor: result.page.nextCursor ?? null,
          },
        },
        providerModelsMetadata: {
          ...this.state.providerModelsMetadata,
          [providerId]: result.metadata,
        },
        selectedModelView: result.view,
        selectedModelId:
          this.state.selectedProviderId === providerId
            ? this.resolveSelectedModelIdForProvider(
                providerId,
                this.state.selectedModelId,
                pickerModels,
              )
            : this.state.selectedModelId,
      });
      this.log("[loadProviderModels] Success", {
        providerId,
        modelCount: pickerModels.length,
        view: result.view,
        hasMore: result.page.hasMore,
        stale: result.metadata.stale,
      });
      return pickerModels;
    } catch (error) {
      if (this.isWorkspaceEpochStale("loadProviderModels", epoch)) {
        return this.state.providerModels[providerId] ?? [];
      }

      const message =
        error instanceof Error
          ? error.message
          : "Failed to load provider models";
      const fallbackModels = this.state.providerModels[providerId] ?? [];

      this.setState({
        providerModels: {
          ...this.state.providerModels,
          [providerId]: fallbackModels,
        },
        providerModelsPage: {
          ...this.state.providerModelsPage,
          [providerId]: {
            view: options.view,
            hasMore: false,
            nextCursor: null,
          },
        },
        providerModelsMetadata: {
          ...this.state.providerModelsMetadata,
          [providerId]: {
            fetchedAt: new Date().toISOString(),
            stale: true,
            source: "cache",
            staleReason: "provider_api_unavailable",
          },
        },
        error: message,
      });

      this.log("[loadProviderModels] Error", {
        providerId,
        error: message,
      });
      throw error;
    }
  }

  private async executeLoadManageProviderModels(
    providerId: string,
    limit: number,
    epoch: number,
  ): Promise<ProviderModelOption[]> {
    this.log("[loadManageProviderModels] Starting", { providerId, limit });
    try {
      const result = await this.apiClient.getProviderModels(providerId, {
        view: "all",
        surface: "manage",
        limit,
      });
      if (this.isWorkspaceEpochStale("loadManageProviderModels", epoch)) {
        return result.models;
      }

      this.setState({
        manageProviderModels: {
          ...this.state.manageProviderModels,
          [providerId]: result.models,
        },
        providerModels: {
          ...this.state.providerModels,
          [providerId]: this.syncPickerModelsWithVisibleManagedModels(
            providerId,
            this.state.providerModels[providerId] ?? [],
            this.state.visibleModelIds,
            result.models,
          ),
        },
      });

      this.log("[loadManageProviderModels] Success", {
        providerId,
        modelCount: result.models.length,
      });
      return result.models;
    } catch (error) {
      if (this.isWorkspaceEpochStale("loadManageProviderModels", epoch)) {
        return this.state.manageProviderModels[providerId] ?? [];
      }
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load management models";
      this.setState({ error: message });
      this.log("[loadManageProviderModels] Error", {
        providerId,
        error: message,
      });
      throw error;
    }
  }

  private async executeRefreshProviderModels(
    providerId: string,
    epoch: number,
  ): Promise<void> {
    this.log("[refreshProviderModels] Starting", { providerId });
    await this.apiClient.refreshProviderModels(providerId);
    if (this.isWorkspaceEpochStale("refreshProviderModels", epoch)) {
      return;
    }
    await this.loadProviderModels(providerId, {
      view: this.state.selectedModelView,
      append: false,
    });
    if (
      Object.prototype.hasOwnProperty.call(
        this.state.manageProviderModels,
        providerId,
      )
    ) {
      await this.loadManageProviderModels(
        providerId,
        this.state.manageProviderModels[providerId]?.length || 150,
      );
    }
  }

  /**
   * Internal preferences update implementation
   */
  private async executeUpdatePreferences(
    partial: BYOKPreferencesUpdateRequest,
  ): Promise<void> {
    this.log("[updatePreferences] Starting", partial);
    const epoch = this.workspaceEpoch;

    try {
      const updated = await this.apiClient.updatePreferences(partial);
      if (this.isWorkspaceEpochStale("updatePreferences", epoch)) {
        return;
      }
      const selection = this.deriveSelectionSnapshot({
        catalog: this.state.catalog,
        credentials: this.state.credentials,
        preferences: updated,
        providerModels: this.state.providerModels,
        visibleModelIds: this.state.visibleModelIds,
        selectedProviderId: this.state.selectedProviderId,
        selectedCredentialId: this.state.selectedCredentialId,
        selectedModelId: this.state.selectedModelId,
      });

      this.setState({
        preferences: updated,
        selectedProviderId: selection.selectedProviderId,
        selectedCredentialId: selection.selectedCredentialId,
        selectedModelId: selection.selectedModelId,
      });

      this.log("[updatePreferences] Success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update preferences";
      this.log("[updatePreferences] Error", { error: message });
      throw error;
    }
  }

  /**
   * Set current provider/credential/model selection
   */
  setSelection(
    providerId: string,
    credentialId: string,
    modelId?: string,
  ): void {
    this.log("[setSelection] Updating", {
      providerId,
      credentialId,
      modelId,
    });

    this.setState({
      selectedProviderId: providerId,
      selectedCredentialId: credentialId,
      selectedModelId: modelId || null,
    });
  }

  /**
   * Apply session selection through a single authoritative write path.
   * Updates selection and resolves runtime config in one operation.
   */
  async applySessionSelection(
    request: SessionSelectionRequest,
  ): Promise<ProviderResolution> {
    const selection = {
      selectedProviderId: request.providerId,
      selectedCredentialId: request.credentialId,
      selectedModelId: request.modelId ?? null,
    } satisfies ProviderSelectionSnapshot;
    this.setSelection(
      selection.selectedProviderId,
      selection.selectedCredentialId,
      selection.selectedModelId ?? undefined,
    );
    this.persistRunScopedSelection(selection);
    await this.persistSelectionAsWorkspaceDefault(selection);
    return this.resolveForChat();
  }

  private async persistSelectionAsWorkspaceDefault(
    selection: ProviderSelectionSnapshot,
  ): Promise<void> {
    if (!selection.selectedProviderId || !selection.selectedModelId) {
      return;
    }

    if (
      this.state.preferences?.defaultProviderId ===
        selection.selectedProviderId &&
      this.state.preferences.defaultModelId === selection.selectedModelId
    ) {
      return;
    }

    await this.updatePreferences({
      defaultProviderId: selection.selectedProviderId,
      defaultModelId: selection.selectedModelId,
    });
  }

  /**
   * Resolve provider configuration for chat
   *
   * Returns the effective provider config based on selection and preferences.
   */
  async resolveForChat(): Promise<ProviderResolution> {
    const selection = this.deriveSelectionSnapshot({
      catalog: this.state.catalog,
      credentials: this.state.credentials,
      preferences: this.state.preferences,
      providerModels: this.state.providerModels,
      visibleModelIds: this.state.visibleModelIds,
      selectedProviderId: this.state.selectedProviderId,
      selectedCredentialId: this.state.selectedCredentialId,
      selectedModelId: this.state.selectedModelId,
    });
    const selectionKey = this.buildResolveSelectionKey(selection);

    if (
      this.state.lastResolvedConfig &&
      this.lastResolveSelectionKey === selectionKey &&
      !this.lastResolveError
    ) {
      return this.state.lastResolvedConfig;
    }
    if (
      this.lastResolveError &&
      this.lastResolveSelectionKey === selectionKey
    ) {
      throw this.lastResolveError;
    }

    const key = "resolve";

    if (this.inflight.has(key)) {
      this.log("[resolveForChat] Request already in flight");
      await this.inflight.get(key)?.promise;
      if (this.state.lastResolvedConfig) {
        return this.state.lastResolvedConfig;
      }
      throw new Error("Provider resolution failed.");
    }

    const promise = this.executeResolve(
      selection,
      selectionKey,
      this.runScopeEpoch,
    );
    this.trackInflight(key, promise, "run");

    try {
      await promise;
      return this.state.lastResolvedConfig!;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Internal resolve implementation
   */
  private async executeResolve(
    selection: ProviderSelectionSnapshot,
    selectionKey: string,
    epoch: number,
  ): Promise<void> {
    this.log("[resolveForChat] Starting");
    const request: {
      providerId?: string;
      credentialId?: string;
      modelId?: string;
    } = {};
    if (selection.selectedProviderId) {
      request.providerId = selection.selectedProviderId;
    }
    if (selection.selectedCredentialId) {
      request.credentialId = selection.selectedCredentialId;
    }
    if (selection.selectedModelId) {
      request.modelId = selection.selectedModelId;
    }

    try {
      const config = await this.apiClient.resolveForChat(request);
      if (this.isRunScopeEpochStale("resolveForChat", epoch)) {
        return;
      }

      const normalizedCredentialId =
        config.credentialId.trim().length > 0 ? config.credentialId : null;
      const effectiveModelId = this.resolveModelForResolvedProvider(
        config.providerId,
        config.modelId,
      );
      if (!effectiveModelId) {
        throw new Error(
          `No visible model is selected for provider "${config.providerId}". Select at least one visible model and retry.`,
        );
      }

      this.setState({
        lastResolvedConfig: {
          ...config,
          modelId: effectiveModelId,
        },
        selectedProviderId: config.providerId,
        selectedCredentialId: normalizedCredentialId,
        selectedModelId: effectiveModelId,
        axisQuota:
          config.providerId === "axis" && config.quota
            ? {
                used: config.quota.used,
                limit: config.quota.limit,
                resetsAt: config.quota.resetsAt,
              }
            : null,
      });
      this.lastResolveSelectionKey = selectionKey;
      this.lastResolveError = null;

      this.log("[resolveForChat] Success", {
        providerId: config.providerId,
        modelId: effectiveModelId,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to resolve provider configuration";
      this.lastResolveSelectionKey = selectionKey;
      this.lastResolveError =
        error instanceof Error ? error : new Error(message);
      this.log("[resolveForChat] Error", { error: message });
      throw error;
    }
  }

  /**
   * Toggle model visibility for a provider and persist to backend
   */
  toggleModelVisibility(providerId: string, modelId: string): void {
    const currentSet = this.state.visibleModelIds[providerId];
    let next: Set<string>;
    if (currentSet) {
      next = new Set(currentSet);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
    } else {
      // Provider was unconfigured. Initialize from all loaded models,
      // then remove the toggled model to hide it.
      const allModelIds = (this.state.providerModels[providerId] ?? []).map(
        (m) => m.id,
      );
      next = new Set(allModelIds);
      next.delete(modelId);
    }
    const newVisibleModelIds = {
      ...this.state.visibleModelIds,
      [providerId]: next,
    };
    const nextProviderModels = {
      ...this.state.providerModels,
      [providerId]: this.syncPickerModelsWithVisibleManagedModels(
        providerId,
        this.state.providerModels[providerId] ?? [],
        newVisibleModelIds,
      ),
    };
    const selection =
      this.state.selectedProviderId === providerId
        ? this.deriveSelectionSnapshot({
            catalog: this.state.catalog,
            credentials: this.state.credentials,
            preferences: this.state.preferences,
            providerModels: nextProviderModels,
            visibleModelIds: newVisibleModelIds,
            selectedProviderId: this.state.selectedProviderId,
            selectedCredentialId: this.state.selectedCredentialId,
            selectedModelId: this.state.selectedModelId,
          })
        : null;
    this.setState({
      providerModels: nextProviderModels,
      visibleModelIds: newVisibleModelIds,
      selectedProviderId:
        selection?.selectedProviderId ?? this.state.selectedProviderId,
      selectedCredentialId:
        selection?.selectedCredentialId ?? this.state.selectedCredentialId,
      selectedModelId: selection?.selectedModelId ?? this.state.selectedModelId,
    });
    // Persist changes to backend (fire and forget with error logging)
    this.persistVisibilityChanges(newVisibleModelIds).catch((error) => {
      this.log("[toggleModelVisibility] Failed to persist changes", {
        providerId,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Set visible models for a provider and persist to backend
   */
  setProviderVisibleModels(providerId: string, modelIds: string[]): void {
    const newVisibleModelIds = {
      ...this.state.visibleModelIds,
      [providerId]: new Set(modelIds),
    };
    const nextProviderModels = {
      ...this.state.providerModels,
      [providerId]: this.syncPickerModelsWithVisibleManagedModels(
        providerId,
        this.state.providerModels[providerId] ?? [],
        newVisibleModelIds,
      ),
    };
    const selection =
      this.state.selectedProviderId === providerId
        ? this.deriveSelectionSnapshot({
            catalog: this.state.catalog,
            credentials: this.state.credentials,
            preferences: this.state.preferences,
            providerModels: nextProviderModels,
            visibleModelIds: newVisibleModelIds,
            selectedProviderId: this.state.selectedProviderId,
            selectedCredentialId: this.state.selectedCredentialId,
            selectedModelId: this.state.selectedModelId,
          })
        : null;
    this.setState({
      providerModels: nextProviderModels,
      visibleModelIds: newVisibleModelIds,
      selectedProviderId:
        selection?.selectedProviderId ?? this.state.selectedProviderId,
      selectedCredentialId:
        selection?.selectedCredentialId ?? this.state.selectedCredentialId,
      selectedModelId: selection?.selectedModelId ?? this.state.selectedModelId,
    });
    // Persist changes to backend (fire and forget with error logging)
    this.persistVisibilityChanges(newVisibleModelIds).catch((error) => {
      this.log("[setProviderVisibleModels] Failed to persist changes", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Persist visibility changes to backend
   * Converts Sets to arrays for API payload
   */
  private async persistVisibilityChanges(
    visibleModelIds: Record<string, Set<string>>,
  ): Promise<void> {
    await this.updatePreferences({
      visibleModelIds: serializeVisibleModelIds(visibleModelIds),
    });
  }

  /**
   * Clear error state
   */
  clearError(): void {
    this.setState({ error: null });
  }

  /**
   * Reset store to initial state
   */
  reset(): void {
    this.resetAll();
  }

  resetRunScope(): void {
    this.runScopeEpoch += 1;
    this.clearInflightByScope("run");
    this.lastResolveSelectionKey = null;
    this.lastResolveError = null;
    this.state = {
      ...this.state,
      ...createInitialRunScopedState(),
      error: null,
    };
    this.emit();
  }

  resetAll(): void {
    this.workspaceEpoch += 1;
    this.runScopeEpoch += 1;
    this.inflight.clear();
    this.bootstrapPromise = null;
    this.lastResolveSelectionKey = null;
    this.lastResolveError = null;
    this.activeRunId = null;
    clearPersistedRunScopedSelections();
    this.state = createInitialStoreState();
    this.emit();
  }

  /**
   * Internal state setter with notification
   */
  private setState(partial: Partial<ProviderStoreState>): void {
    const shouldInvalidateResolution = this.shouldInvalidateResolution(partial);
    const nextPartial =
      shouldInvalidateResolution && partial.lastResolvedConfig === undefined
        ? { ...partial, lastResolvedConfig: null, axisQuota: null }
        : partial;
    if (shouldInvalidateResolution) {
      this.lastResolveSelectionKey = null;
      this.lastResolveError = null;
    }
    this.state = { ...this.state, ...nextPartial };
    this.emit();
  }

  /**
   * Emit state change to all listeners
   */
  private emit(): void {
    this.listeners.forEach((listener) => listener(this.getState()));
  }

  /**
   * Internal logging helper
   */
  private log(message: string, context?: unknown): void {
    if (this.enableLogging) {
      console.log(`[ProviderStore] ${message}`, context);
    }
  }

  private shouldInvalidateResolution(
    partial: Partial<ProviderStoreState>,
  ): boolean {
    return (
      partial.catalog !== undefined ||
      partial.credentials !== undefined ||
      partial.preferences !== undefined ||
      partial.providerModels !== undefined ||
      partial.providerModelsMetadata !== undefined ||
      partial.providerModelsPage !== undefined ||
      partial.selectedProviderId !== undefined ||
      partial.selectedCredentialId !== undefined ||
      partial.selectedModelId !== undefined
    );
  }

  private buildResolveSelectionKey(
    selection: ProviderSelectionSnapshot,
  ): string {
    return [
      selection.selectedProviderId ?? "none",
      selection.selectedCredentialId ?? "none",
      selection.selectedModelId ?? "none",
    ].join("|");
  }

  private restoreRunScopedSelection(runId: string): boolean {
    const persistedSelection = readRunScopedSelection(runId);
    if (!persistedSelection) {
      return false;
    }

    this.log("[run] restoring persisted run-scoped selection", {
      runId,
      providerId: persistedSelection.selectedProviderId,
      credentialId: persistedSelection.selectedCredentialId,
      modelId: persistedSelection.selectedModelId,
    });
    this.setState(persistedSelection);
    return true;
  }

  private hydrateRunScopedSelectionFromWorkspaceState(
    preferredSelection: ProviderSelectionSnapshot | null = null,
  ): void {
    const selection = this.deriveSelectionSnapshot({
      catalog: this.state.catalog,
      credentials: this.state.credentials,
      preferences: this.state.preferences,
      providerModels: this.state.providerModels,
      visibleModelIds: this.state.visibleModelIds,
      selectedProviderId:
        preferredSelection?.selectedProviderId ?? this.state.selectedProviderId,
      selectedCredentialId:
        preferredSelection?.selectedCredentialId ??
        this.state.selectedCredentialId,
      selectedModelId:
        preferredSelection?.selectedModelId ?? this.state.selectedModelId,
    });

    this.setState({
      selectedProviderId: selection.selectedProviderId,
      selectedCredentialId: selection.selectedCredentialId,
      selectedModelId: selection.selectedModelId,
    });
  }

  private captureRunScopedSelectionSnapshot(): ProviderSelectionSnapshot {
    return {
      selectedProviderId: this.state.selectedProviderId,
      selectedCredentialId: this.state.selectedCredentialId,
      selectedModelId: this.state.selectedModelId,
    };
  }

  private persistRunScopedSelection(
    selection: ProviderSelectionSnapshot,
  ): void {
    if (!this.activeRunId) {
      return;
    }

    writeRunScopedSelection(this.activeRunId, selection);
  }

  private trackInflight(
    key: string,
    promise: Promise<unknown>,
    scope: InflightScope,
  ): void {
    this.inflight.set(key, {
      promise,
      scope,
    });
  }

  private clearInflightByScope(scope: InflightScope): void {
    for (const [key, request] of this.inflight.entries()) {
      if (request.scope === scope) {
        this.inflight.delete(key);
      }
    }
  }

  private resolveLoadOptions(
    providerId: string,
    options: LoadProviderModelsOptions,
  ): ResolvedLoadProviderModelsOptions {
    const pageState = this.state.providerModelsPage[providerId];
    return {
      view: options.view ?? pageState?.view ?? this.state.selectedModelView,
      cursor: options.cursor ?? undefined,
      surface: options.surface ?? "picker",
      limit: options.limit ?? 50,
      append: options.append ?? false,
    };
  }

  private resolveSelectedModelIdForProvider(
    providerId: string,
    currentModelId: string | null,
    models: ProviderModelOption[],
  ): string | null {
    const visibleSet = this.state.visibleModelIds[providerId];
    if (!visibleSet) {
      return currentModelId ?? models[0]?.id ?? null;
    }

    const selectableModels = this.getSelectableModelsForProvider(
      providerId,
      models,
      this.state.visibleModelIds,
    );
    if (currentModelId && visibleSet.has(currentModelId)) {
      return currentModelId;
    }
    if (selectableModels.length === 0) {
      return this.resolvePendingVisibleModelId(
        currentModelId,
        this.state.visibleModelIds[providerId],
      );
    }
    if (!currentModelId) {
      return selectableModels[0]?.id ?? null;
    }
    return selectableModels.some((model) => model.id === currentModelId)
      ? currentModelId
      : (selectableModels[0]?.id ?? null);
  }

  private deriveSelectionSnapshot(input: {
    catalog: ProviderRegistryEntry[];
    credentials: ProviderCredential[];
    preferences: ProviderPreference | null;
    providerModels: Record<string, ProviderModelOption[]>;
    visibleModelIds: Record<string, Set<string>>;
    selectedProviderId: string | null;
    selectedCredentialId: string | null;
    selectedModelId: string | null;
  }): ProviderSelectionSnapshot {
    const {
      catalog,
      credentials,
      preferences,
      providerModels,
      visibleModelIds,
      selectedProviderId,
      selectedCredentialId,
      selectedModelId,
    } = input;
    const catalogProviderIds = new Set(
      catalog.map((entry) => entry.providerId),
    );
    const isSelectableProvider = (providerId: string): boolean =>
      catalogProviderIds.has(providerId);
    const selectedCredential = selectedCredentialId
      ? credentials.find(
          (credential) =>
            credential.credentialId === selectedCredentialId &&
            isSelectableProvider(credential.providerId),
        )
      : undefined;
    const hasSelectedProviderCredential = selectedProviderId
      ? credentials.some(
          (credential) =>
            credential.providerId === selectedProviderId &&
            isSelectableProvider(credential.providerId),
        )
      : false;

    const providerId =
      selectedCredential?.providerId ??
      (hasSelectedProviderCredential ? selectedProviderId : null) ??
      (preferences?.defaultProviderId &&
      isSelectableProvider(preferences.defaultProviderId) &&
      credentials.some(
        (credential) =>
          credential.providerId === preferences.defaultProviderId &&
          isSelectableProvider(credential.providerId),
      )
        ? preferences.defaultProviderId
        : null) ??
      credentials.find((credential) =>
        isSelectableProvider(credential.providerId),
      )?.providerId ??
      null;

    const providerCredentials = providerId
      ? credentials.filter(
          (credential) =>
            credential.providerId === providerId &&
            isSelectableProvider(credential.providerId),
        )
      : [];
    const credentialId =
      providerCredentials.find(
        (credential) => credential.credentialId === selectedCredentialId,
      )?.credentialId ??
      (preferences?.defaultCredentialId &&
      providerCredentials.some(
        (credential) =>
          credential.credentialId === preferences.defaultCredentialId,
      )
        ? preferences.defaultCredentialId
        : null) ??
      providerCredentials[0]?.credentialId ??
      null;

    const preferredModelForProvider =
      providerId && selectedProviderId === providerId ? selectedModelId : null;
    const preferredModelId =
      preferredModelForProvider ??
      (preferences?.defaultProviderId === providerId
        ? preferences.defaultModelId
        : undefined) ??
      (providerId
        ? catalog.find((entry) => entry.providerId === providerId)
            ?.defaultModelId
        : undefined) ??
      null;
    const modelId =
      providerId === null
        ? null
        : this.resolveConstrainedModelId({
            providerId,
            preferredModelId,
            providerModels,
            visibleModelIds,
          });

    return {
      selectedProviderId: providerId,
      selectedCredentialId: credentialId,
      selectedModelId: modelId,
    };
  }

  private resolveConstrainedModelId(input: {
    providerId: string;
    preferredModelId: string | null;
    providerModels: Record<string, ProviderModelOption[]>;
    visibleModelIds: Record<string, Set<string>>;
  }): string | null {
    const { providerId, preferredModelId, providerModels, visibleModelIds } =
      input;
    const selectableModels = this.getSelectableModelsForProvider(
      providerId,
      providerModels[providerId] ?? [],
      visibleModelIds,
    );
    const visibleSet = visibleModelIds[providerId];

    if (!visibleSet) {
      return preferredModelId ?? selectableModels[0]?.id ?? null;
    }

    if (preferredModelId) {
      if (visibleSet.has(preferredModelId)) {
        return preferredModelId;
      }
      if (selectableModels.length > 0) {
        return selectableModels[0]?.id ?? null;
      }
      return this.resolvePendingVisibleModelId(null, visibleSet);
    }

    if (selectableModels.length > 0) {
      return selectableModels[0]?.id ?? null;
    }

    return this.resolvePendingVisibleModelId(null, visibleSet);
  }

  private resolveModelForResolvedProvider(
    providerId: string,
    resolvedModelId: string,
  ): string | null {
    const visibleSet = this.state.visibleModelIds[providerId];
    if (!visibleSet) {
      return (
        resolvedModelId ||
        this.state.providerModels[providerId]?.[0]?.id ||
        null
      );
    }

    if (visibleSet.has(resolvedModelId)) {
      return resolvedModelId;
    }

    const selectableModels = this.getSelectableModelsForProvider(
      providerId,
      this.state.providerModels[providerId] ?? [],
      this.state.visibleModelIds,
    );
    if (selectableModels.length > 0) {
      return selectableModels[0]?.id ?? null;
    }

    return this.resolvePendingVisibleModelId(resolvedModelId, visibleSet);
  }

  private resolvePendingVisibleModelId(
    preferredModelId: string | null,
    visibleSet: Set<string> | undefined,
  ): string | null {
    if (!visibleSet) {
      return preferredModelId;
    }
    if (visibleSet.size === 0) {
      return null;
    }
    if (preferredModelId && visibleSet.has(preferredModelId)) {
      return preferredModelId;
    }
    return visibleSet.values().next().value ?? null;
  }

  private getSelectableModelsForProvider(
    providerId: string,
    models: ProviderModelOption[],
    visibleModelIds: Record<string, Set<string>>,
  ): ProviderModelOption[] {
    const visibleSet = visibleModelIds[providerId];
    if (!visibleSet) {
      return models;
    }
    return models.filter((model) => visibleSet.has(model.id));
  }

  private syncPickerModelsWithVisibleManagedModels(
    providerId: string,
    pickerModels: ProviderModelOption[],
    visibleModelIds: Record<string, Set<string>>,
    manageModelsOverride?: ProviderModelOption[],
  ): ProviderModelOption[] {
    const visibleSet = visibleModelIds[providerId];
    if (!visibleSet || visibleSet.size === 0) {
      return pickerModels;
    }

    const manageModels =
      manageModelsOverride ?? this.state.manageProviderModels[providerId] ?? [];
    if (manageModels.length === 0) {
      return pickerModels;
    }

    const curatedVisibleModels = manageModels.filter((model) =>
      visibleSet.has(model.id),
    );
    if (curatedVisibleModels.length === 0) {
      return pickerModels;
    }

    return mergeModelsById(pickerModels, curatedVisibleModels);
  }

  private collectBootstrapModelPreloadProviderIds(
    catalog: ProviderRegistryEntry[],
    credentials: ProviderCredential[],
  ): string[] {
    const providerIds = new Set<string>();
    const catalogProviderIds = new Set(
      catalog.map((entry) => entry.providerId),
    );

    if (
      catalogProviderIds.has("axis") &&
      canPreloadProvider(WEB_PROVIDER_POLICY, "axis")
    ) {
      providerIds.add("axis");
    }

    for (const credential of credentials) {
      if (
        catalogProviderIds.has(credential.providerId) &&
        canPreloadProvider(WEB_PROVIDER_POLICY, credential.providerId)
      ) {
        providerIds.add(credential.providerId);
      }
    }

    return Array.from(providerIds);
  }

  private isWorkspaceEpochStale(operation: string, epoch: number): boolean {
    if (epoch === this.workspaceEpoch) {
      return false;
    }
    this.log(`[${operation}] skipping stale workspace async result`, {
      operationEpoch: epoch,
      currentEpoch: this.workspaceEpoch,
    });
    return true;
  }

  private isRunScopeEpochStale(operation: string, epoch: number): boolean {
    if (epoch === this.runScopeEpoch) {
      return false;
    }
    this.log(`[${operation}] skipping stale run-scoped async result`, {
      operationEpoch: epoch,
      currentEpoch: this.runScopeEpoch,
    });
    return true;
  }
}

function serializeVisibleModelIds(
  visibleModelIds: Record<string, Set<string>>,
): Record<string, string[]> {
  const visibleModelIdsRecord: Record<string, string[]> = {};
  for (const [providerId, modelSet] of Object.entries(visibleModelIds)) {
    visibleModelIdsRecord[providerId] = Array.from(modelSet);
  }
  return visibleModelIdsRecord;
}

function createInitialStoreState(): ProviderStoreState {
  return {
    ...createInitialWorkspaceGlobalState(),
    ...createInitialRunScopedState(),
    ...createInitialOperationalState(),
  };
}

function createInitialWorkspaceGlobalState(): ProviderWorkspaceGlobalState {
  return {
    catalog: [],
    credentials: [],
    preferences: null,
    providerModels: {},
    manageProviderModels: {},
    providerModelsMetadata: {},
    providerModelsPage: {},
    visibleModelIds: {},
  };
}

function createInitialRunScopedState(): ProviderRunScopedState {
  return {
    selectedProviderId: null,
    selectedCredentialId: null,
    selectedModelId: null,
    lastResolvedConfig: null,
    axisQuota: null,
  };
}

function createInitialOperationalState(): ProviderOperationalState {
  return {
    status: "idle",
    error: null,
    isValidating: false,
    loadingModelsForProviderId: null,
    loadingManageModelsForProviderIds: {},
    selectedModelView: "popular",
    refreshingModelsForProviderId: null,
  };
}

function hasWorkspaceGlobalState(state: ProviderStoreState): boolean {
  return (
    state.catalog.length > 0 ||
    state.credentials.length > 0 ||
    state.preferences !== null ||
    Object.keys(state.providerModels).length > 0 ||
    Object.keys(state.visibleModelIds).length > 0
  );
}

function writeRunScopedSelection(
  runId: string,
  selection: ProviderSelectionSnapshot,
): void {
  try {
    sessionStorage.setItem(
      buildRunScopedSelectionStorageKey(runId),
      JSON.stringify(selection),
    );
  } catch (error) {
    console.warn(
      "[provider/store] failed to persist run-scoped selection",
      error,
    );
  }
}

function readRunScopedSelection(
  runId: string,
): ProviderSelectionSnapshot | null {
  try {
    const serialized = sessionStorage.getItem(
      buildRunScopedSelectionStorageKey(runId),
    );
    if (!serialized) {
      return null;
    }

    const parsed: unknown = JSON.parse(serialized);
    if (!isProviderSelectionSnapshot(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn(
      "[provider/store] failed to restore run-scoped selection",
      error,
    );
    return null;
  }
}

function buildRunScopedSelectionStorageKey(runId: string): string {
  return `${RUN_SCOPED_SELECTION_STORAGE_KEY_PREFIX}${runId}`;
}

function clearPersistedRunScopedSelections(): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key && key.startsWith(RUN_SCOPED_SELECTION_STORAGE_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
  } catch (error) {
    console.warn(
      "[provider/store] failed to clear persisted run-scoped selections",
      error,
    );
  }
}

function isProviderSelectionSnapshot(
  value: unknown,
): value is ProviderSelectionSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    isNullableString(record.selectedProviderId) &&
    isNullableString(record.selectedCredentialId) &&
    isNullableString(record.selectedModelId)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function mergeModelsById(
  existingModels: ProviderModelOption[],
  nextModels: ProviderModelOption[],
): ProviderModelOption[] {
  if (existingModels.length === 0) {
    return [...nextModels];
  }
  const merged = [...existingModels];
  const knownIds = new Set(existingModels.map((model) => model.id));
  for (const model of nextModels) {
    if (knownIds.has(model.id)) {
      continue;
    }
    knownIds.add(model.id);
    merged.push(model);
  }
  return merged;
}
