import type {
  BYOKDiscoveredProviderModel,
  BYOKModelDiscoverySource,
  BYOKPreferences,
  BYOKPreferencesPatch,
  BYOKValidationMode,
  ProviderId,
} from "@repo/shared-types";

export const PROVIDER_CREDENTIAL_STATUSES = [
  "connected",
  "failed",
  "revoked",
] as const;

export type ProviderCredentialStatus =
  (typeof PROVIDER_CREDENTIAL_STATUSES)[number];

export function buildProviderCredentialStatusSqlList(): string {
  return PROVIDER_CREDENTIAL_STATUSES.map((status) => `'${status}'`).join(", ");
}

export const PROVIDER_AUDIT_EVENT_TYPES = [
  "connect",
  "validate",
  "disconnect",
  "preferences",
  "resolution_failure",
] as const;

export type ProviderAuditEventType =
  (typeof PROVIDER_AUDIT_EVENT_TYPES)[number];

export function buildProviderAuditEventTypeSqlList(): string {
  return PROVIDER_AUDIT_EVENT_TYPES.map((status) => `'${status}'`).join(", ");
}

export const PROVIDER_AUDIT_STATUSES = ["success", "failure"] as const;

export type ProviderAuditStatus = (typeof PROVIDER_AUDIT_STATUSES)[number];

export function buildProviderAuditStatusSqlList(): string {
  return PROVIDER_AUDIT_STATUSES.map((status) => `'${status}'`).join(", ");
}

export interface ProviderCredentialRecord {
  credentialId: string;
  userId: string;
  workspaceId: string;
  providerId: ProviderId;
  label: string;
  keyFingerprint: string;
  encryptedSecretJson: string;
  keyVersion: string;
  status: ProviderCredentialStatus;
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
  workspaceId?: string;
  providerId: ProviderId;
  label: string;
  apiKey: string;
  createdBy?: string;
}

export interface CredentialStore {
  getCredential(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null>;
  getCredentialWithKey(
    providerId: ProviderId,
  ): Promise<{ record: ProviderCredentialRecord; apiKey: string } | null>;
  setCredential(input: SetCredentialInput): Promise<ProviderCredentialRecord>;
  deleteCredential(providerId: ProviderId): Promise<void>;
  listCredentialProviders(): Promise<ProviderId[]>;
  updateCredentialMetadata(
    providerId: ProviderId,
    updates: {
      status?: ProviderCredentialStatus;
      lastValidatedAt?: string | null;
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
    },
  ): Promise<void>;
}

export interface PreferenceStore {
  getPreferences(): Promise<BYOKPreferences>;
  updatePreferences(patch: BYOKPreferencesPatch): Promise<BYOKPreferences>;
  setCredentialLabel(credentialId: string, label: string): Promise<void>;
  deleteCredentialLabel(credentialId: string): Promise<void>;
}

export interface ProviderAuditEvent {
  eventType: ProviderAuditEventType;
  status: ProviderAuditStatus;
  providerId?: ProviderId;
  credentialId?: string;
  errorCode?: string;
  validationMode?: BYOKValidationMode;
  message?: string;
  metadataJson?: string;
}

export interface ProviderAuditLog {
  appendAuditEvent(event: ProviderAuditEvent): Promise<void>;
}

export interface ProviderQuotaStore {
  getAxisQuotaUsage(dayKey: string): Promise<number>;
  setAxisQuotaUsage(dayKey: string, usage: number): Promise<void>;
  incrementAndGetQuota(dayKey: string): Promise<number>;
}

export interface ProviderModelCacheRecord {
  providerId: string;
  models: BYOKDiscoveredProviderModel[];
  fetchedAt: string;
  expiresAt: string;
  source: BYOKModelDiscoverySource;
}

export interface UserScopedCacheKey {
  providerId: string;
  credentialId: string;
}

export interface ProviderModelCacheStore {
  getModelCache(providerId: string): Promise<ProviderModelCacheRecord | null>;
  setModelCache(record: ProviderModelCacheRecord): Promise<void>;
  invalidateModelCache(providerId: string): Promise<void>;
  getUserModelCache(
    key: UserScopedCacheKey,
  ): Promise<ProviderModelCacheRecord | null>;
  setUserModelCache(
    key: UserScopedCacheKey,
    record: ProviderModelCacheRecord,
  ): Promise<void>;
  invalidateUserModelCache(key: UserScopedCacheKey): Promise<void>;
}
