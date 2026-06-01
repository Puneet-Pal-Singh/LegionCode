/**
 * IProviderConfigService
 * Interface for provider configuration operations
 * Enables dependency injection and testing with mocks
 */

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
} from "@repo/shared-types";
import type { ModelsListResponse } from "../../schemas/provider";

/**
 * Minimal provider config service interface
 * Exposes the public operations without implementation details
 */
export interface IProviderConfigService {
  getCatalog(): Promise<ProviderCatalogResponse>;
  getConnections(): Promise<ProviderConnectionsResponse>;
  connect(request: BYOKConnectRequest): Promise<BYOKConnectResponse>;
  validate(request: BYOKValidateRequest): Promise<BYOKValidateResponse>;
  disconnect(
    request: BYOKDisconnectRequest,
  ): Promise<{ status: "disconnected"; providerId: ProviderId }>;
  getPreferences(): Promise<BYOKPreferences>;
  updatePreferences(patch: BYOKPreferencesPatch): Promise<BYOKPreferences>;
  setCredentialLabel(
    credentialId: string,
    label: string,
  ): Promise<BYOKPreferences>;
  deleteCredentialLabel(credentialId: string): Promise<BYOKPreferences>;
  getStatus(): Promise<ProviderConnection[]>;
  getModels(providerId: ProviderId): Promise<ModelsListResponse>;
  getDiscoveredModels(
    providerId: ProviderId,
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse>;
  refreshDiscoveredModels(
    providerId: ProviderId,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse>;
  getOpenRouterDiscoveredModels(
    query: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse>;
  refreshOpenRouterDiscoveredModels(): Promise<BYOKDiscoveredProviderModelsRefreshResponse>;
  getApiKey(providerId: ProviderId): Promise<string | null>;
  getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined>;
  isConnected(providerId: ProviderId): Promise<boolean>;
}
