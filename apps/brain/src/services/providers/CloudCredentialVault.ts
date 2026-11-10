import { ProviderConnectionConfigSchema } from "@repo/shared-types";
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
import type {
  CredentialStore,
  SetCredentialInput,
} from "./stores/CredentialStore";

export class CloudCredentialVault implements CredentialVault {
  readonly surface = "cloud" as const;

  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly userId: string,
    private readonly selectedConnection?: (
      providerId: ProviderId,
    ) => Promise<string | undefined>,
    private readonly reconnectCredential?: (
      input: SetCredentialInput,
    ) => Promise<void>,
  ) {}

  async setCredential(
    providerId: ProviderId,
    apiKey: string,
    connectionConfig?: ProviderConnectionConfig,
  ): Promise<void> {
    connectionConfig = connectionConfig
      ? ProviderConnectionConfigSchema.parse(connectionConfig)
      : undefined;
    const input: SetCredentialInput = {
      userId: this.userId,
      providerId,
      label: "default",
      apiKey,
      connectionConfig,
    };
    if (this.reconnectCredential) {
      await this.reconnectCredential(input);
      return;
    }
    // Standalone legacy vaults have no selected workspace preference. Selected
    // Connect must have the canonical atomic owner; never substitute a default.
    if (this.selectedConnection)
      throw new Error("Atomic selected credential reconnect is unavailable");
    await this.credentialStore.setCredential(
      { ...input, credentialId: crypto.randomUUID() },
      undefined,
    );
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
    const selected = await this.selectedConnection?.(providerId);
    const record =
      selected !== undefined
        ? await this.credentialStore.getConnection(selected)
        : await this.credentialStore.getCredential(providerId);
    const assertSelection = async () => {
      if ((await this.selectedConnection?.(providerId)) !== selected)
        throw new Error("Credential selection changed during disconnect");
    };
    await assertSelection();
    if (!record) {
      if (selected !== undefined)
        throw new Error("Selected credential is unavailable");
      // Preserve the absent-default epoch fence for legacy provider-only calls.
      await this.credentialStore.deleteCredential(providerId);
      await assertSelection();
      return;
    }
    if (
      record.userId !== this.userId ||
      record.providerId !== providerId ||
      (selected !== undefined && record.credentialId !== selected) ||
      record.credentialKind !== "api_key"
    )
      throw new Error("Credential disconnect scope mismatch");
    if (record.status === "revoked" && record.deletedAt !== null) {
      // Sticky explicit selections remain disconnected; never delete a new default.
      await assertSelection();
      return;
    }
    if (record.deletedAt !== null)
      throw new Error("Selected credential is unavailable");
    const expected: CredentialAcquisition = {
      connectionId: record.credentialId,
      userId: this.userId,
      providerId,
      ownerGeneration: record.authOwnerGeneration,
      tokenMaterialVersion: record.tokenMaterialVersion,
    };
    await assertSelection();
    if (record.isDefault) {
      await this.credentialStore.deleteCredential(providerId, expected);
    } else {
      const revoked = await this.credentialStore.revokeConnection(expected);
      if (!revoked) {
        const current = await this.credentialStore.getConnection(
          expected.connectionId,
        );
        if (
          !current ||
          current.userId !== this.userId ||
          current.providerId !== providerId ||
          current.authOwnerGeneration !== expected.ownerGeneration + 1 ||
          current.status !== "revoked" ||
          current.deletedAt === null
        )
          throw new Error("Credential changed during disconnect");
      }
    }
    // A concurrent explicit picker change must not report the new target as
    // disconnected. Only the captured target was ever eligible for revocation.
    await assertSelection();
  }

  async isConnected(providerId: ProviderId): Promise<boolean> {
    return (await this.resolveCredential(providerId)) !== null;
  }

  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    return (await this.resolveCredential(providerId))?.connectionConfig;
  }

  async listConnectedProviders(): Promise<ProviderId[]> {
    const allProviders = await this.credentialStore.listCredentialProviders();
    const connectedProviders: ProviderId[] = [];
    for (const providerId of allProviders) {
      if (await this.isConnected(providerId)) {
        connectedProviders.push(providerId);
      }
    }
    return connectedProviders;
  }
}
