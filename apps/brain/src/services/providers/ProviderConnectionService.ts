/**
 * ProviderConnectionService
 * Single Responsibility: Query provider connection status
 */

import type {
  ProviderConnection,
  ProviderConnectionConfig,
  ProviderId,
} from "@repo/shared-types";
import type { ProviderCredentialService } from "./ProviderCredentialService";
import { ProviderRegistryService } from "./ProviderRegistryService";

/**
 * ProviderConnectionService - Queries connection status for all providers
 */
export class ProviderConnectionService {
  private credentialService: ProviderCredentialService; // Injected credential service
  private readonly registryService: ProviderRegistryService;

  constructor(
    credentialService: ProviderCredentialService,
    registryService: ProviderRegistryService,
  ) {
    this.credentialService = credentialService;
    this.registryService = registryService;
  }

  /**
   * Get connection status for all providers
   */
  async getStatus(): Promise<ProviderConnection[]> {
    return this.resolveConnections({ includeCapabilities: false });
  }

  async getConnections(): Promise<ProviderConnection[]> {
    return this.resolveConnections({ includeCapabilities: true });
  }

  private async resolveConnections(input: {
    includeCapabilities: boolean;
  }): Promise<ProviderConnection[]> {
    const connections: ProviderConnection[] = [];
    for (const providerId of this.registryService.listProviderIds()) {
      connections.push(
        await this.resolveProviderConnection(
          providerId,
          input.includeCapabilities,
        ),
      );
    }
    return connections;
  }

  private async resolveProviderConnection(
    providerId: ProviderId,
    includeCapabilities: boolean,
  ): Promise<ProviderConnection> {
    const capabilities = includeCapabilities
      ? this.registryService.getProviderCapabilities(providerId)
      : undefined;
    try {
      const isConnected = await this.credentialService.isConnected(providerId);
      const config = isConnected
        ? await readCredentialConnectionConfig(
            this.credentialService,
            providerId,
          )
        : undefined;
      return {
        providerId,
        status: isConnected ? "connected" : "disconnected",
        lastValidatedAt: isConnected ? new Date().toISOString() : undefined,
        capabilities,
        config,
      };
    } catch (error) {
      console.warn(
        `[provider/connections] failed to read connection status for ${providerId}`,
        error,
      );
      return {
        providerId,
        status: "failed",
        errorCode: "PROVIDER_UNAVAILABLE",
        errorMessage:
          "Credential store is temporarily unavailable for this provider.",
        capabilities,
      };
    }
  }
}

async function readCredentialConnectionConfig(
  credentialService: ProviderCredentialService,
  providerId: ProviderId,
): Promise<ProviderConnectionConfig | undefined> {
  if (!("getConnectionConfig" in credentialService)) {
    return undefined;
  }
  const reader = credentialService.getConnectionConfig;
  if (typeof reader !== "function") {
    return undefined;
  }
  return reader.call(credentialService, providerId) as Promise<
    ProviderConnectionConfig | undefined
  >;
}
