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
import type {
  CredentialStore,
  ProviderCredentialRecord,
} from "./stores/CredentialStore";

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

  /** Runtime key and endpoint configuration must come from one fenced acquisition. */
  async resolveRuntimeCredential(providerId: ProviderId): Promise<{
    apiKey: string;
    connectionConfig?: ProviderConnectionConfig;
    credentialId: string;
    ownerGeneration: number;
    tokenMaterialVersion: number;
  } | null> {
    const record = await this.getConnectionMetadata(providerId);
    if (
      !record ||
      !this.isUsableCredential(record, providerId) ||
      record.credentialKind !== "api_key"
    )
      return null;
    if (record.isDefault) {
      const result =
        await this.credentialStore.getCredentialWithKey(providerId);
      if (
        !result ||
        !this.isUsableCredential(result.record, providerId) ||
        result.record.credentialId !== record.credentialId ||
        result.record.authOwnerGeneration !== record.authOwnerGeneration ||
        result.record.tokenMaterialVersion !== record.tokenMaterialVersion
      )
        return null;
      return {
        apiKey: result.apiKey,
        connectionConfig: result.record.connectionConfig,
        credentialId: record.credentialId,
        ownerGeneration: record.authOwnerGeneration,
        tokenMaterialVersion: record.tokenMaterialVersion,
      };
    }
    const result = await this.credentialStore.acquireConnection({
      connectionId: record.credentialId,
      userId: this.userId,
      providerId,
      ownerGeneration: record.authOwnerGeneration,
      tokenMaterialVersion: record.tokenMaterialVersion,
    });
    if (!result || result.secret.type !== "api_key") return null;
    return {
      apiKey: result.secret.apiKey,
      connectionConfig: result.record.connectionConfig,
      credentialId: record.credentialId,
      ownerGeneration: record.authOwnerGeneration,
      tokenMaterialVersion: record.tokenMaterialVersion,
    };
  }
  async getApiKey(providerId: ProviderId): Promise<string | null> {
    return (await this.resolveRuntimeCredential(providerId))?.apiKey ?? null;
  }
  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    const record = await this.getConnectionMetadata(providerId);
    return record &&
      this.isUsableCredential(record, providerId) &&
      record.credentialKind === "api_key"
      ? record.connectionConfig
      : undefined;
  }
  async getConnectionMetadata(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null> {
    const selected = await this.selectedConnection?.(providerId);
    const record = selected
      ? await this.credentialStore.getConnection(selected)
      : await this.credentialStore.getCredential(providerId);
    if (!record) return null;
    this.isUsableCredential(record, providerId);
    return record;
  }
  async deleteCredential(providerId: ProviderId): Promise<void> {
    const selected = await this.selectedConnection?.(providerId);
    if (!selected) return this.credentialStore.deleteCredential(providerId);
    const record = await this.getConnectionMetadata(providerId);
    if (!record) return;
    if (record.isDefault)
      return this.credentialStore.deleteCredential(providerId);
    await this.credentialStore.revokeConnection({
      connectionId: record.credentialId,
      userId: this.userId,
      providerId,
      ownerGeneration: record.authOwnerGeneration,
      tokenMaterialVersion: record.tokenMaterialVersion,
    });
  }
  async isConnected(providerId: ProviderId): Promise<boolean> {
    const record = await this.getConnectionMetadata(providerId);
    return (
      !!record &&
      this.isUsableCredential(record, providerId) &&
      record.credentialKind === "api_key"
    );
  }
  async listConnectedProviders(): Promise<ProviderId[]> {
    const providers = await this.credentialStore.listCredentialProviders();
    const connected: ProviderId[] = [];
    for (const id of providers)
      if (await this.isConnected(id)) connected.push(id);
    return connected;
  }

  private isUsableCredential(
    record: ProviderCredentialRecord,
    providerId: ProviderId,
  ): boolean {
    if (record.userId !== this.userId || record.providerId !== providerId) {
      throw new Error("Credential scope does not match the authorized vault");
    }
    return record.status === "connected" && record.deletedAt === null;
  }
}
