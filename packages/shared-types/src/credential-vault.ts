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

/** Private credential-custody payloads. Never return these from public operations. */
export const CredentialSecretSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("api_key"), apiKey: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({
      type: z.literal("oauth"),
      accessToken: z.string().min(1).max(16384),
      refreshToken: z.string().min(1).max(16384).optional(),
      expiresAt: z.number().int().safe().nonnegative(),
      accountId: z.string().min(1).max(512),
      issuer: z.string().url(),
      clientId: z.string().min(1).max(512),
      scopes: z.array(z.string().min(1)).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("external_reference"),
      authority: z.literal("provider_owned"),
      referenceId: z.string().uuid(),
    })
    .strict(),
]);
export type CredentialSecret = z.infer<typeof CredentialSecretSchema>;

export const CredentialAcquisitionSchema = z
  .object({
    connectionId: z.string().uuid(),
    userId: z.string().min(1),
    providerId: ProviderIdSchema,
    ownerGeneration: z.number().int().safe().positive(),
    tokenMaterialVersion: z.number().int().safe().positive(),
  })
  .strict();
export type CredentialAcquisition = z.infer<typeof CredentialAcquisitionSchema>;
export type CredentialRefreshClaim = CredentialAcquisition & {
  refreshClaimId: string;
};
