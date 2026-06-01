/**
 * Provider Config Service
 *
 * Facade for provider configuration and credential management.
 *
 * Uses focused, single-responsibility stores:
 * - CredentialStore: Credential operations
 * - PreferenceStore: Preference operations
 * - ProviderAuditLog: Audit logging
 * - ProviderQuotaStore: Axis quota tracking
 */

import type { Env } from "../../types/ai";
import type {
  BYOKConnectRequest,
  BYOKConnectResponse,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsRefreshResponse,
  BYOKDiscoveredProviderModelsResponse,
  BYOKDisconnectRequest,
  BYOKPreferences,
  BYOKPreferencesPatch,
  BYOKValidateRequest,
  BYOKValidateResponse,
  ProviderCatalogResponse,
  ProviderConnection,
  ProviderConnectionConfig,
  ProviderConnectionsResponse,
  ProviderId,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import type { ModelsListResponse } from "../../schemas/provider";
import type { CredentialStore } from "./stores/CredentialStore";
import type { PreferenceStore } from "./stores/PreferenceStore";
import type { ProviderModelCacheStore } from "./stores/ProviderModelCacheStore";
import type { ProviderAuditLog } from "./stores/ProviderAuditLog";
import type { ProviderQuotaStore } from "./stores/ProviderQuotaStore";
import { CloudCredentialVault } from "./CloudCredentialVault";
import { ProviderCredentialService } from "./ProviderCredentialService";
import { ProviderCatalogService } from "./ProviderCatalogService";
import { ProviderConnectionService } from "./ProviderConnectionService";
import { ProviderRegistryService } from "./ProviderRegistryService";
import {
  AXIS_DAILY_LIMIT,
  AXIS_PROVIDER_ID,
  getAxisDiscoveredModels,
} from "./axis";
import { ProviderModelDiscoveryService } from "./model-discovery";
import type { ProviderModelDiscoveryService as ProviderModelDiscoveryServiceType } from "./model-discovery";
import { isDomainError } from "../../domain/errors";

export interface ProviderConfigServiceOptions {
  env: Env;
  userId: string;
  workspaceId: string;
  credentialStore: CredentialStore;
  preferenceStore: PreferenceStore;
  modelCacheStore: ProviderModelCacheStore;
  auditLog: ProviderAuditLog;
  quotaStore: ProviderQuotaStore;
  ensureReady?: () => Promise<void>;
}

export class ProviderConfigService {
  private credentialVault: CloudCredentialVault;
  private credentialService: ProviderCredentialService;
  private registryService: ProviderRegistryService;
  private catalogService: ProviderCatalogService | null = null;
  private modelDiscoveryService: ProviderModelDiscoveryServiceType | null =
    null;
  private connectionService: ProviderConnectionService;
  private storageReadyPromise: Promise<void> | null = null;

  constructor(private options: ProviderConfigServiceOptions) {
    this.registryService = new ProviderRegistryService();
    this.credentialVault = new CloudCredentialVault(
      options.credentialStore,
      options.userId,
    );
    this.credentialService = new ProviderCredentialService(
      options.env,
      this.credentialVault,
      this.registryService,
    );
    this.connectionService = new ProviderConnectionService(
      this.credentialService,
      this.registryService,
    );
  }

  async getCatalog(): Promise<ProviderCatalogResponse> {
    await this.ensureStorageReady();
    return this.getCatalogService().getCatalog();
  }

  async getConnections(): Promise<ProviderConnectionsResponse> {
    await this.ensureStorageReady();
    const connections = await this.connectionService.getConnections();
    return { connections };
  }

  async connect(request: BYOKConnectRequest): Promise<BYOKConnectResponse> {
    await this.ensureStorageReady();
    try {
      const response = await this.credentialService.connect(request);
      await this.options.auditLog.appendAuditEvent({
        eventType: "connect",
        status: response.status === "connected" ? "success" : "failure",
        providerId: request.providerId,
        message: response.errorMessage,
      });
      return response;
    } catch (error) {
      await this.options.auditLog.appendAuditEvent({
        eventType: "connect",
        status: "failure",
        providerId: request.providerId,
        errorCode: toErrorCode(error),
        message: toErrorMessage(error),
      });
      throw error;
    }
  }

  async validate(request: BYOKValidateRequest): Promise<BYOKValidateResponse> {
    await this.ensureStorageReady();
    try {
      const response = await this.credentialService.validate(request);
      await this.options.auditLog.appendAuditEvent({
        eventType: "validate",
        status: response.status === "valid" ? "success" : "failure",
        providerId: request.providerId,
        validationMode: response.validationMode,
      });
      return response;
    } catch (error) {
      await this.options.auditLog.appendAuditEvent({
        eventType: "validate",
        status: "failure",
        providerId: request.providerId,
        validationMode: request.mode,
        errorCode: toErrorCode(error),
        message: toErrorMessage(error),
      });
      throw error;
    }
  }

  async disconnect(
    request: BYOKDisconnectRequest,
  ): Promise<{ status: "disconnected"; providerId: ProviderId }> {
    await this.ensureStorageReady();
    try {
      const response = await this.credentialService.disconnect(request);
      await this.options.auditLog.appendAuditEvent({
        eventType: "disconnect",
        status: "success",
        providerId: request.providerId,
      });
      return response;
    } catch (error) {
      await this.options.auditLog.appendAuditEvent({
        eventType: "disconnect",
        status: "failure",
        providerId: request.providerId,
        errorCode: toErrorCode(error),
        message: toErrorMessage(error),
      });
      throw error;
    }
  }

  async getPreferences(): Promise<BYOKPreferences> {
    await this.ensureStorageReady();
    return this.options.preferenceStore.getPreferences();
  }

  async updatePreferences(
    patch: BYOKPreferencesPatch,
  ): Promise<BYOKPreferences> {
    await this.ensureStorageReady();
    try {
      const response =
        await this.options.preferenceStore.updatePreferences(patch);
      await this.options.auditLog.appendAuditEvent({
        eventType: "preferences",
        status: "success",
        providerId: patch.defaultProviderId,
      });
      return response;
    } catch (error) {
      await this.options.auditLog.appendAuditEvent({
        eventType: "preferences",
        status: "failure",
        providerId: patch.defaultProviderId,
        errorCode: toErrorCode(error),
        message: toErrorMessage(error),
      });
      throw error;
    }
  }

  async setCredentialLabel(
    credentialId: string,
    label: string,
  ): Promise<BYOKPreferences> {
    await this.ensureStorageReady();
    try {
      await this.options.preferenceStore.setCredentialLabel(
        credentialId,
        label,
      );
      return await this.options.preferenceStore.getPreferences();
    } catch (error) {
      throw error;
    }
  }

  async deleteCredentialLabel(credentialId: string): Promise<BYOKPreferences> {
    await this.ensureStorageReady();
    try {
      await this.options.preferenceStore.deleteCredentialLabel(credentialId);
      return await this.options.preferenceStore.getPreferences();
    } catch (error) {
      throw error;
    }
  }

  async getStatus(): Promise<ProviderConnection[]> {
    await this.ensureStorageReady();
    return this.connectionService.getStatus();
  }

  async getModels(providerId: ProviderId): Promise<ModelsListResponse> {
    await this.ensureStorageReady();
    return this.getCatalogService().getDiscoveredModels(providerId);
  }

  async getDiscoveredModels(
    providerId: ProviderId,
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    await this.ensureStorageReady();
    if (providerId === AXIS_PROVIDER_ID) {
      return this.getCatalogService().getStaticDiscoveredModelsForAxis(query);
    }
    return this.getModelDiscoveryService().getDiscoveredModels(
      providerId,
      query,
    );
  }

  async refreshDiscoveredModels(
    providerId: ProviderId,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    await this.ensureStorageReady();
    if (providerId === AXIS_PROVIDER_ID) {
      return {
        providerId: AXIS_PROVIDER_ID,
        refreshedAt: new Date().toISOString(),
        source: "provider_api",
        cacheInvalidated: false,
        modelsCount: getAxisDiscoveredModels().length,
      };
    }
    return this.getModelDiscoveryService().refreshDiscoveredModels(providerId);
  }

  async getApiKey(providerId: ProviderId): Promise<string | null> {
    await this.ensureStorageReady();
    return this.credentialVault.getApiKey(providerId);
  }

  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    await this.ensureStorageReady();
    return this.credentialVault.getConnectionConfig(providerId);
  }

  async isConnected(providerId: ProviderId): Promise<boolean> {
    await this.ensureStorageReady();
    return this.credentialVault.isConnected(providerId);
  }

  async getAxisQuotaStatus(): Promise<{
    used: number;
    limit: number;
    resetsAt: string;
  }> {
    await this.ensureStorageReady();
    const dayKey = new Date().toISOString().slice(0, 10);
    const used = await this.options.quotaStore.getAxisQuotaUsage(dayKey);
    return {
      used,
      limit: AXIS_DAILY_LIMIT,
      resetsAt: getNextUtcDayBoundary(),
    };
  }

  async consumeAxisQuota(
    correlationId?: string,
  ): Promise<{ used: number; limit: number; resetsAt: string }> {
    await this.ensureStorageReady();
    const dayKey = new Date().toISOString().slice(0, 10);
    const used = await this.options.quotaStore.incrementAndGetQuota(dayKey);
    return {
      used,
      limit: AXIS_DAILY_LIMIT,
      resetsAt: getNextUtcDayBoundary(),
    };
  }

  private getCatalogService(): ProviderCatalogService {
    if (!this.catalogService) {
      this.catalogService = new ProviderCatalogService(
        this.registryService,
        this.getModelDiscoveryService(),
        async (provider: ProviderRegistryEntry) =>
          this.canExposeCatalogProvider(provider),
      );
    }
    return this.catalogService;
  }

  private getModelDiscoveryService() {
    if (!this.modelDiscoveryService) {
      this.modelDiscoveryService = new ProviderModelDiscoveryService(
        this.options.modelCacheStore,
        this.credentialService,
        this.registryService,
      );
    }
    return this.modelDiscoveryService;
  }

  static resetForTests(): void {
    ProviderCredentialService.resetForTests();
  }

  private async canExposeCatalogProvider(
    provider: ProviderRegistryEntry,
  ): Promise<boolean> {
    if (!provider.authModes.includes("platform_managed")) {
      return true;
    }
    return this.credentialService.isConnected(
      provider.providerId as ProviderId,
    );
  }

  private async ensureStorageReady(): Promise<void> {
    if (!this.options.ensureReady) {
      return;
    }

    if (!this.storageReadyPromise) {
      this.storageReadyPromise = this.options.ensureReady().catch((error) => {
        this.storageReadyPromise = null;
        throw error;
      });
    }

    await this.storageReadyPromise;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

function toErrorCode(error: unknown): string | undefined {
  return isDomainError(error) ? error.code : undefined;
}

function getNextUtcDayBoundary(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return next.toISOString();
}
