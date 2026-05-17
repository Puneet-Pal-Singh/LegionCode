/**
 * Provider Store Interfaces
 *
 * Focused, single-responsibility interfaces for BYOK state management.
 * These interfaces are platform-agnostic; Brain wires them to Postgres.
 */

export type {
  CredentialStore,
  ProviderCredentialRecord,
  SetCredentialInput,
} from "./CredentialStore";

export type { PreferenceStore } from "./PreferenceStore";

export type {
  WorkspaceMetadataStore,
  WorkspaceByokMetadata,
} from "./WorkspaceMetadataStore";

export type { ProviderAuditLog, ProviderAuditEvent } from "./ProviderAuditLog";

export type { ProviderQuotaStore } from "./ProviderQuotaStore";

export type {
  ProviderModelCacheStore,
  ProviderModelCacheRecord,
} from "./ProviderModelCacheStore";
export { createPostgresProviderConfigService } from "./PostgresStoreFactory";
export { getProviderEncryptionConfig } from "./ProviderEncryptionConfig";
