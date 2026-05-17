/**
 * BYOK Credential Entity
 *
 * Represents an API key credential for a provider.
 * Secrets are stored encrypted at rest.
 * Never expose plaintext outside encryption/decryption boundary.
 */

import { z } from "zod";

/**
 * BYOKCredential - User's API key for a provider
 *
 * This is the internal entity stored in canonical provider persistence.
 * Includes encrypted secret payload.
 */
export const BYOKCredentialSchema = z.object({
  /** Unique credential ID (uuid) */
  credentialId: z.string().uuid(),

  /** User who owns this credential */
  userId: z.string().min(1),

  /** Workspace scope */
  workspaceId: z.string().min(1),

  /** Provider this credential is for */
  providerId: z.string().min(1).max(64),

  /** User-friendly label (for multiple keys per provider) */
  label: z.string().min(1).max(256),

  /** Safe fingerprint of the key (for display/validation only) */
  keyFingerprint: z.string().min(8).max(256),

  /** Encrypted secret payload (ciphertext JSON) */
  encryptedSecretJson: z.string().min(1),

  /** Key version used for encryption */
  keyVersion: z.string().min(1),

  /** Connection status */
  status: z.enum(["connected", "failed", "revoked"]).default("connected"),

  /** Last time this credential was validated */
  lastValidatedAt: z.string().datetime().nullable().default(null),

  /** Last error code if status is 'failed' */
  lastErrorCode: z.string().optional(),

  /** Last error message if status is 'failed' */
  lastErrorMessage: z.string().optional(),

  /** Metadata: who created this */
  createdBy: z.string().optional(),

  /** Timestamps */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),

  /** Soft delete support */
  deletedAt: z.string().datetime().nullable().default(null),
});

export type BYOKCredential = z.infer<typeof BYOKCredentialSchema>;

/**
 * BYOKCredentialDTO - Client-facing view of a credential
 *
 * Never includes plaintext secret or encryption details.
 * Safe to send over HTTP.
 */
export const BYOKCredentialDTOSchema = BYOKCredentialSchema.omit({
  encryptedSecretJson: true,
  keyVersion: true,
});

export type BYOKCredentialDTO = z.infer<typeof BYOKCredentialDTOSchema>;
