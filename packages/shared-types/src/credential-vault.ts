import { z } from "zod";
import {
  ProviderIdSchema,
  type ProviderConnectionConfig,
  type ProviderId,
} from "./provider.js";

/**
 * Declares runtime surface for credential vault implementations.
 */
export const CredentialVaultSurfaceSchema = z.enum(["cloud", "desktop"]);
export type CredentialVaultSurface = z.infer<
  typeof CredentialVaultSurfaceSchema
>;

/**
 * Provider credential metadata exposed by vault list operations.
 * Never includes raw secrets.
 */
export const CredentialVaultEntrySchema = z.object({
  providerId: ProviderIdSchema,
});
export type CredentialVaultEntry = z.infer<typeof CredentialVaultEntrySchema>;

/**
 * Provider-neutral credential storage interface.
 * All credential reads/writes must go through this abstraction.
 */
export interface CredentialVault {
  readonly surface: CredentialVaultSurface;
  setCredential(
    providerId: ProviderId,
    apiKey: string,
    connectionConfig?: ProviderConnectionConfig,
  ): Promise<void>;
  getApiKey(providerId: ProviderId): Promise<string | null>;
  getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined>;
  deleteCredential(providerId: ProviderId): Promise<void>;
  isConnected(providerId: ProviderId): Promise<boolean>;
  listConnectedProviders(): Promise<ProviderId[]>;
}

export class CredentialVaultUnsupportedOperationError extends Error {
  constructor(surface: CredentialVaultSurface, method: string) {
    super(
      `CredentialVault method "${method}" is not supported on "${surface}" surface.`,
    );
    this.name = "CredentialVaultUnsupportedOperationError";
  }
}
