import {
  CredentialVaultUnsupportedOperationError,
  type CredentialVault,
  type ProviderConnectionConfig,
  type ProviderId,
} from "@repo/shared-types";

/**
 * DesktopCredentialVaultStub
 * Compile-time contract stub for desktop surface parity.
 *
 * This intentionally fails fast until a desktop keychain-backed implementation
 * is introduced in the desktop runtime.
 */
export class DesktopCredentialVaultStub implements CredentialVault {
  readonly surface = "desktop" as const;

  async setCredential(
    _providerId: ProviderId,
    _apiKey: string,
    _connectionConfig?: ProviderConnectionConfig,
  ): Promise<void> {
    throw this.unsupported("setCredential");
  }

  async getApiKey(_providerId: ProviderId): Promise<string | null> {
    throw this.unsupported("getApiKey");
  }

  async getConnectionConfig(
    _providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    throw this.unsupported("getConnectionConfig");
  }

  async deleteCredential(_providerId: ProviderId): Promise<void> {
    throw this.unsupported("deleteCredential");
  }

  async isConnected(_providerId: ProviderId): Promise<boolean> {
    throw this.unsupported("isConnected");
  }

  async listConnectedProviders(): Promise<ProviderId[]> {
    throw this.unsupported("listConnectedProviders");
  }

  private unsupported(
    method: string,
  ): CredentialVaultUnsupportedOperationError {
    return new CredentialVaultUnsupportedOperationError(this.surface, method);
  }
}
