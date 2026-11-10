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
  CredentialAcquisition,
} from "@repo/shared-types";
import type { CredentialStore } from "./stores/CredentialStore";

export class CloudCredentialVault implements CredentialVault {
  readonly surface = "cloud" as const;

  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly userId: string,
    private readonly selectedConnection?: (
      providerId: ProviderId,
    ) => Promise<string | undefined>,
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
    return (await this.resolveCredential(providerId))?.apiKey ?? null;
  }

  /** Discovery receives the selected key and endpoint config from one fenced
   * acquisition. A stale explicit selection never falls back to another payer. */
  async resolveCredential(providerId: ProviderId): Promise<{
    apiKey: string;
    connectionConfig?: ProviderConnectionConfig;
    credentialId: string;
    ownerGeneration: number;
    tokenMaterialVersion: number;
  } | null> {
    const selected = await this.selectedConnection?.(providerId);
    const before =
      selected !== undefined
        ? await this.credentialStore.getConnection(selected)
        : await this.credentialStore.getCredential(providerId);
    if (
      !before ||
      before.userId !== this.userId ||
      before.providerId !== providerId ||
      (selected !== undefined && before.credentialId !== selected) ||
      before.status !== "connected" ||
      before.deletedAt !== null ||
      before.credentialKind !== "api_key" ||
      before.refreshClaimId !== null
    )
      return null;
    const expected: CredentialAcquisition = {
      connectionId: before.credentialId,
      userId: this.userId,
      providerId,
      ownerGeneration: before.authOwnerGeneration,
      tokenMaterialVersion: before.tokenMaterialVersion,
    };
    // The default API owns its explicit legacy-ciphertext migration. It is still
    // required to return this exact captured connection/version, never a new default.
    const result = before.isDefault
      ? await this.credentialStore.getCredentialWithKey(providerId)
      : await this.credentialStore.acquireConnection(expected);
    if (
      !result ||
      result.record.credentialId !== expected.connectionId ||
      result.record.userId !== expected.userId ||
      result.record.providerId !== providerId ||
      result.record.authOwnerGeneration !== expected.ownerGeneration ||
      result.record.tokenMaterialVersion !== expected.tokenMaterialVersion ||
      result.record.status !== "connected" ||
      result.record.deletedAt !== null ||
      result.record.refreshClaimId !== null ||
      result.record.credentialKind !== "api_key"
    )
      return null;
    const apiKey =
      "secret" in result
        ? result.secret.type === "api_key"
          ? result.secret.apiKey
          : null
        : result.apiKey;
    if (apiKey === null) return null;
    return {
      apiKey,
      ...(result.record.connectionConfig
        ? { connectionConfig: result.record.connectionConfig }
        : {}),
      credentialId: result.record.credentialId,
      ownerGeneration: result.record.authOwnerGeneration,
      tokenMaterialVersion: result.record.tokenMaterialVersion,
    };
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
