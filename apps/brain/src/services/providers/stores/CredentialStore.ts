/**
 * Credential Store Interface
 *
 * Focused interface for BYOK credential storage.
 * Credentials are user-global (keyed by user_id, not workspace_id).
 */

import type { ProviderConnectionConfig, ProviderId } from "@repo/shared-types";

export interface ProviderCredentialRecord {
  credentialId: string;
  userId: string;
  workspaceId: string; // Kept as metadata only
  providerId: ProviderId;
  label: string;
  keyFingerprint: string;
  encryptedSecretJson: string;
  connectionConfig?: ProviderConnectionConfig;
  keyVersion: string;
  status: "connected" | "failed" | "revoked";
  lastValidatedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SetCredentialInput {
  credentialId: string;
  userId: string;
  workspaceId?: string; // Optional for metadata
  providerId: ProviderId;
  label: string;
  apiKey: string;
  connectionConfig?: ProviderConnectionConfig;
  createdBy?: string;
}

export interface CredentialStore {
  /**
   * Get credential by provider ID for a user
   */
  getCredential(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null>;

  /**
   * Get credential with decrypted API key
   */
  getCredentialWithKey(
    providerId: ProviderId,
  ): Promise<{ record: ProviderCredentialRecord; apiKey: string } | null>;

  /**
   * Set a new credential (encrypts and stores)
   */
  setCredential(input: SetCredentialInput): Promise<ProviderCredentialRecord>;

  /**
   * Delete a credential (soft delete)
   */
  deleteCredential(providerId: ProviderId): Promise<void>;

  /**
   * List all credential providers for a user
   */
  listCredentialProviders(): Promise<ProviderId[]>;

  /**
   * Update credential metadata
   */
  updateCredentialMetadata(
    providerId: ProviderId,
    updates: {
      status?: "connected" | "failed" | "revoked";
      lastValidatedAt?: string | null;
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
    },
  ): Promise<void>;
}
