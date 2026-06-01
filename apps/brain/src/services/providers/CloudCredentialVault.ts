/**
 * Cloud Credential Vault
 *
 * Provider-neutral credential vault using the canonical provider credential
 * repository interface.
 */

import type {
  CredentialVault,
  ProviderConnectionConfig,
  ProviderId,
} from "@repo/shared-types";
import type { CredentialStore } from "./stores/CredentialStore";

export class CloudCredentialVault implements CredentialVault {
  readonly surface = "cloud" as const;

  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly userId: string,
  ) {}

  async setCredential(
    providerId: ProviderId,
    apiKey: string,
    connectionConfig?: ProviderConnectionConfig,
  ): Promise<void> {
    await this.credentialStore.setCredential({
      credentialId: crypto.randomUUID(),
      userId: this.userId,
      providerId,
      label: "default",
      apiKey,
      connectionConfig,
    });
  }

  async getApiKey(providerId: ProviderId): Promise<string | null> {
    const result = await this.credentialStore.getCredentialWithKey(providerId);
    return result?.apiKey ?? null;
  }

  async deleteCredential(providerId: ProviderId): Promise<void> {
    await this.credentialStore.deleteCredential(providerId);
  }

  async isConnected(providerId: ProviderId): Promise<boolean> {
    const cred = await this.credentialStore.getCredential(providerId);
    return cred !== null && cred.status === "connected";
  }

  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    const credential = await this.credentialStore.getCredential(providerId);
    return credential?.connectionConfig;
  }

  async listConnectedProviders(): Promise<ProviderId[]> {
    const allProviders = await this.credentialStore.listCredentialProviders();
    const connectedProviders: ProviderId[] = [];
    for (const providerId of allProviders) {
      const cred = await this.credentialStore.getCredential(providerId);
      if (cred && cred.status === "connected") {
        connectedProviders.push(providerId);
      }
    }
    return connectedProviders;
  }
}
