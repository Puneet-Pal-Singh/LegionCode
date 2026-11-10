import {
  CredentialSecretSchema,
  CredentialAcquisitionSchema,
  ProviderConnectionConfigSchema,
  type CredentialAcquisition,
  type CredentialRefreshClaim,
  type CredentialSecret,
} from "@repo/shared-types";
import {
  ConnectionSecretCodec,
  acquisition,
  matches,
  sameOAuthAccount,
} from "./connection-custody.js";
import type {
  BYOKPreferences,
  BYOKPreferencesPatch,
  ProviderId,
} from "@repo/shared-types";
import { CredentialEncryptionService } from "./credential-encryption.js";
import type {
  CredentialConnectionStore,
  CreateCredentialConnectionInput,
  CredentialStore,
  PreferenceStore,
  ProviderAuditEvent,
  ProviderAuditLog,
  ProviderCredentialRecord,
  ProviderModelCacheRecord,
  ProviderModelCacheStore,
  ProviderQuotaStore,
  SetCredentialInput,
  UserScopedCacheKey,
} from "./types.js";

export class MemoryCredentialStore
  implements CredentialStore, CredentialConnectionStore
{
  private readonly encryption = new CredentialEncryptionService();
  private readonly codec: ConnectionSecretCodec;
  private readonly records = new Map<string, ProviderCredentialRecord>();
  private readonly epochs = new Map<ProviderId, number>();
  constructor(
    private readonly userId: string,
    private readonly workspaceId: string,
    masterKey: string,
    private readonly keyVersion: string,
    previousMasterKey?: string,
  ) {
    this.codec = new ConnectionSecretCodec(
      masterKey,
      keyVersion,
      previousMasterKey,
    );
  }
  async getCredential(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null> {
    return this.clone(this.findDefault(providerId));
  }
  async getConnection(
    connectionId: string,
  ): Promise<ProviderCredentialRecord | null> {
    return this.clone(this.records.get(connectionId));
  }
  async getCredentialWithKey(
    providerId: ProviderId,
  ): Promise<{ record: ProviderCredentialRecord; apiKey: string } | null> {
    const record = this.findDefault(providerId);
    if (
      !record ||
      record.status !== "connected" ||
      record.credentialKind !== "api_key" ||
      record.refreshClaimId
    )
      return null;
    const secret = await this.codec.decode(record, true);
    if (secret.type !== "api_key") return null;
    if (!this.codec.isLegacy(record)) {
      if (this.records.get(record.credentialId) !== record) return null;
      return { record: structuredClone(record), apiKey: secret.apiKey };
    }
    const encryptedSecretJson = await this.codec.encode(secret, record);
    if (this.records.get(record.credentialId) !== record) return null;
    const migrated = {
      ...record,
      encryptedSecretJson,
      keyVersion: this.keyVersion,
    };
    this.records.set(record.credentialId, migrated);
    return { record: structuredClone(migrated), apiKey: secret.apiKey };
  }
  async setCredential(
    input: SetCredentialInput,
  ): Promise<ProviderCredentialRecord> {
    this.authorize(input.userId);
    if (!this.encryption.isValidKeyFormat(input.apiKey))
      throw new Error("Invalid API key format");
    const before = this.findDefault(input.providerId);
    const epoch = this.epochs.get(input.providerId) ?? 0;
    const next = this.newRecord(
      input,
      before?.credentialId ?? input.credentialId ?? crypto.randomUUID(),
      true,
    );
    if (before) {
      next.authOwnerGeneration = before.authOwnerGeneration + 1;
      next.tokenMaterialVersion = before.tokenMaterialVersion + 1;
      next.createdAt = before.createdAt;
    }
    next.encryptedSecretJson = await this.codec.encode(
      { type: "api_key", apiKey: input.apiKey },
      next,
    );
    next.keyFingerprint = await this.encryption.generateFingerprint(
      input.apiKey,
    );
    if (
      (this.epochs.get(input.providerId) ?? 0) !== epoch ||
      this.findDefault(input.providerId) !== before ||
      (!before && this.records.has(next.credentialId))
    )
      throw new Error(
        "Credential replacement conflicted with revocation or rotation",
      );
    this.records.set(next.credentialId, next);
    return structuredClone(next);
  }
  async createConnection(
    input: CreateCredentialConnectionInput,
  ): Promise<ProviderCredentialRecord> {
    this.authorize(input.userId);
    const secret = CredentialSecretSchema.parse(input.secret);
    const next = this.newRecord(input, crypto.randomUUID(), false);
    next.credentialKind = secret.type;
    next.encryptedSecretJson = await this.codec.encode(secret, next);
    if (secret.type === "api_key")
      next.keyFingerprint = await this.encryption.generateFingerprint(
        secret.apiKey,
      );
    this.records.set(next.credentialId, next);
    return structuredClone(next);
  }
  async acquireConnection(expected: CredentialAcquisition) {
    this.authorize(expected.userId);
    CredentialAcquisitionSchema.parse(expected);
    const before = this.records.get(expected.connectionId);
    if (!before || !matches(before, expected) || before.refreshClaimId)
      return null;
    const secret = await this.codec.decode(before);
    if (this.records.get(expected.connectionId) !== before) return null;
    return { record: structuredClone(before), secret };
  }
  async claimRefresh(expected: CredentialAcquisition) {
    this.authorize(expected.userId);
    CredentialAcquisitionSchema.parse(expected);
    const before = this.records.get(expected.connectionId);
    if (
      !before ||
      !matches(before, expected) ||
      before.credentialKind !== "oauth" ||
      before.refreshClaimId
    )
      return null;
    const refreshClaimId = crypto.randomUUID();
    const next = { ...before, refreshClaimId };
    this.records.set(next.credentialId, next);
    const secret = await this.codec.decode(next);
    if (secret.type !== "oauth" || this.records.get(next.credentialId) !== next)
      return null;
    return { claim: { ...expected, refreshClaimId }, secret };
  }
  async completeRefresh(
    claim: CredentialRefreshClaim,
    secret: Extract<CredentialSecret, { type: "oauth" }>,
  ): Promise<ProviderCredentialRecord | null> {
    this.authorize(claim.userId);
    const before = this.records.get(claim.connectionId);
    if (
      !before ||
      !matches(before, claim) ||
      before.refreshClaimId !== claim.refreshClaimId
    )
      return null;
    const previous = await this.codec.decode(before);
    const parsed = CredentialSecretSchema.parse(secret);
    if (!sameOAuthAccount(previous, parsed))
      throw new Error("Refresh cannot change credential ownership or scope");
    const next = {
      ...before,
      tokenMaterialVersion: before.tokenMaterialVersion + 1,
      refreshClaimId: null,
      keyVersion: this.keyVersion,
      updatedAt: new Date().toISOString(),
    };
    next.encryptedSecretJson = await this.codec.encode(parsed, next);
    if (this.records.get(next.credentialId) !== before) return null;
    this.records.set(next.credentialId, next);
    return structuredClone(next);
  }
  async revokeConnection(
    expected: CredentialAcquisition,
  ): Promise<ProviderCredentialRecord | null> {
    this.authorize(expected.userId);
    const before = this.records.get(expected.connectionId);
    if (
      !before ||
      before.userId !== expected.userId ||
      before.providerId !== expected.providerId ||
      before.authOwnerGeneration !== expected.ownerGeneration ||
      before.deletedAt !== null
    )
      return null;
    const now = new Date().toISOString();
    const next = {
      ...before,
      authOwnerGeneration: before.authOwnerGeneration + 1,
      status: "revoked" as const,
      deletedAt: now,
      updatedAt: now,
      encryptedSecretJson: "{}",
      refreshClaimId: null,
      isDefault: false,
    };
    this.epochs.set(
      before.providerId,
      (this.epochs.get(before.providerId) ?? 0) + 1,
    );
    this.records.set(next.credentialId, next);
    return structuredClone(next);
  }
  async deleteCredential(providerId: ProviderId): Promise<void> {
    this.epochs.set(providerId, (this.epochs.get(providerId) ?? 0) + 1);
    const before = this.findDefault(providerId);
    if (before) await this.revokeConnection(acquisition(before));
  }
  async listCredentialProviders(): Promise<ProviderId[]> {
    return [
      ...new Set(
        [...this.records.values()]
          .filter(
            (record) =>
              record.status === "connected" && record.deletedAt === null,
          )
          .map((record) => record.providerId),
      ),
    ].sort();
  }
  async updateCredentialMetadata(
    providerId: ProviderId,
    updates: Parameters<CredentialStore["updateCredentialMetadata"]>[1],
  ): Promise<void> {
    if (updates.status === "revoked") return this.deleteCredential(providerId);
    const before = this.findDefault(providerId);
    if (!before || before.status !== "connected") return;
    this.records.set(before.credentialId, {
      ...before,
      status: updates.status ?? before.status,
      lastValidatedAt:
        updates.lastValidatedAt !== undefined
          ? updates.lastValidatedAt
          : before.lastValidatedAt,
      lastErrorCode:
        updates.lastErrorCode !== undefined
          ? updates.lastErrorCode
          : before.lastErrorCode,
      lastErrorMessage:
        updates.lastErrorMessage !== undefined
          ? updates.lastErrorMessage
          : before.lastErrorMessage,
      updatedAt: new Date().toISOString(),
    });
  }
  private authorize(userId: string) {
    if (!userId || userId !== this.userId)
      throw new Error("Credential scope mismatch");
  }
  private findDefault(providerId: ProviderId): ProviderCredentialRecord | null {
    return (
      [...this.records.values()].find(
        (r) =>
          r.providerId === providerId &&
          r.userId === this.userId &&
          r.isDefault &&
          r.deletedAt === null,
      ) ?? null
    );
  }
  private clone(
    r: ProviderCredentialRecord | null | undefined,
  ): ProviderCredentialRecord | null {
    return r ? structuredClone(r) : null;
  }
  private newRecord(
    input: {
      providerId: ProviderId;
      label: string;
      connectionConfig?: ProviderCredentialRecord["connectionConfig"];
    },
    id: string,
    isDefault: boolean,
  ): ProviderCredentialRecord {
    const connectionConfig = input.connectionConfig
      ? ProviderConnectionConfigSchema.parse(input.connectionConfig)
      : undefined;
    if (connectionConfig && connectionConfig.providerId !== input.providerId)
      throw new Error("Credential configuration scope mismatch");
    const now = new Date().toISOString();
    return {
      credentialId: id,
      userId: this.userId,
      workspaceId: this.workspaceId,
      providerId: input.providerId,
      label: input.label,
      authOwnerGeneration: 1,
      tokenMaterialVersion: 1,
      credentialKind: "api_key",
      refreshClaimId: null,
      isDefault,
      keyFingerprint: "unavailable",
      encryptedSecretJson: "{}",
      connectionConfig,
      keyVersion: this.keyVersion,
      status: "connected",
      lastValidatedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
  }
}

export class MemoryPreferenceStore implements PreferenceStore {
  private readonly preferences = new Map<string, BYOKPreferences>();

  constructor(
    private readonly userId: string,
    private readonly workspaceId: string,
  ) {}

  async getPreferences(): Promise<BYOKPreferences> {
    return this.clonePreferences(
      this.preferences.get(this.key()) ?? this.defaultPreferences(),
    );
  }

  async updatePreferences(
    patch: BYOKPreferencesPatch,
  ): Promise<BYOKPreferences> {
    const current = await this.getPreferences();
    const next = this.clonePreferences({
      defaultProviderId: patch.defaultProviderId ?? current.defaultProviderId,
      defaultCredentialId:
        patch.defaultCredentialId ??
        (patch.defaultProviderId !== undefined &&
        patch.defaultProviderId !== current.defaultProviderId
          ? undefined
          : current.defaultCredentialId),
      defaultModelId: patch.defaultModelId ?? current.defaultModelId,
      visibleModelIds: patch.visibleModelIds ?? current.visibleModelIds,
      credentialLabels: current.credentialLabels,
      updatedAt: new Date().toISOString(),
    });

    this.preferences.set(this.key(), next);
    return this.clonePreferences(next);
  }

  async setCredentialLabel(credentialId: string, label: string): Promise<void> {
    const current = await this.getPreferences();
    this.preferences.set(this.key(), {
      ...current,
      credentialLabels: {
        ...current.credentialLabels,
        [credentialId]: label,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteCredentialLabel(credentialId: string): Promise<void> {
    const current = await this.getPreferences();
    const credentialLabels = { ...current.credentialLabels };
    delete credentialLabels[credentialId];
    this.preferences.set(this.key(), {
      ...current,
      credentialLabels,
      updatedAt: new Date().toISOString(),
    });
  }

  private defaultPreferences(): BYOKPreferences {
    return {
      defaultProviderId: undefined,
      defaultModelId: undefined,
      visibleModelIds: {},
      credentialLabels: {},
      updatedAt: new Date().toISOString(),
    };
  }

  private clonePreferences(preferences: BYOKPreferences): BYOKPreferences {
    return {
      ...preferences,
      visibleModelIds: cloneVisibleModelIds(preferences.visibleModelIds ?? {}),
      credentialLabels: { ...preferences.credentialLabels },
    };
  }

  private key(): string {
    return `${this.userId}:${this.workspaceId}`;
  }
}

function cloneVisibleModelIds(
  visibleModelIds: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(visibleModelIds).map(([providerId, modelIds]) => [
      providerId,
      [...modelIds],
    ]),
  );
}

export class MemoryProviderAuditLog implements ProviderAuditLog {
  private readonly events: ProviderAuditEvent[] = [];

  async appendAuditEvent(event: ProviderAuditEvent): Promise<void> {
    this.events.push({ ...event });
  }

  listEvents(): ProviderAuditEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export class MemoryProviderQuotaStore implements ProviderQuotaStore {
  private readonly usageByDay = new Map<string, number>();

  async getAxisQuotaUsage(dayKey: string): Promise<number> {
    return this.usageByDay.get(dayKey) ?? 0;
  }

  async setAxisQuotaUsage(dayKey: string, usage: number): Promise<void> {
    assertValidUsageCount(usage);
    this.usageByDay.set(dayKey, usage);
  }

  async incrementAndGetQuota(dayKey: string): Promise<number> {
    const next = (await this.getAxisQuotaUsage(dayKey)) + 1;
    this.usageByDay.set(dayKey, next);
    return next;
  }
}

function assertValidUsageCount(usage: number): void {
  if (!Number.isFinite(usage) || !Number.isInteger(usage) || usage < 0) {
    throw new Error(
      `[MemoryProviderQuotaStore/setAxisQuotaUsage] invalid usage_count: ${usage}`,
    );
  }
}

export class MemoryProviderModelCacheStore implements ProviderModelCacheStore {
  private readonly globalCache = new Map<string, ProviderModelCacheRecord>();
  private readonly userCache = new Map<string, ProviderModelCacheRecord>();

  async getModelCache(
    providerId: string,
  ): Promise<ProviderModelCacheRecord | null> {
    return this.cloneFresh(this.globalCache.get(providerId));
  }

  async setModelCache(record: ProviderModelCacheRecord): Promise<void> {
    this.globalCache.set(record.providerId, this.cloneRecord(record));
  }

  async invalidateModelCache(providerId: string): Promise<void> {
    this.globalCache.delete(providerId);
  }

  async getUserModelCache(
    key: UserScopedCacheKey,
  ): Promise<ProviderModelCacheRecord | null> {
    return this.cloneFresh(this.userCache.get(this.userKey(key)));
  }

  async setUserModelCache(
    key: UserScopedCacheKey,
    record: ProviderModelCacheRecord,
  ): Promise<void> {
    this.userCache.set(this.userKey(key), this.cloneRecord(record));
  }

  async invalidateUserModelCache(key: UserScopedCacheKey): Promise<void> {
    this.userCache.delete(this.userKey(key));
  }

  private cloneFresh(
    record: ProviderModelCacheRecord | undefined,
  ): ProviderModelCacheRecord | null {
    if (!record || new Date(record.expiresAt) < new Date()) {
      return null;
    }
    return this.cloneRecord({ ...record, source: "cache" });
  }

  private cloneRecord(
    record: ProviderModelCacheRecord,
  ): ProviderModelCacheRecord {
    return {
      ...record,
      models: record.models.map((model) => ({ ...model })),
    };
  }

  private userKey(key: UserScopedCacheKey): string {
    return `${key.providerId}:${key.credentialId}`;
  }
}
