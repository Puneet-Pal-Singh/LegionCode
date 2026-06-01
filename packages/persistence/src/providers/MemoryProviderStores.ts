import type {
  BYOKPreferences,
  BYOKPreferencesPatch,
  ProviderId,
} from "@repo/shared-types";
import {
  CredentialEncryptionService,
  EncryptedSecretSchema,
} from "./credential-encryption.js";
import type {
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

export class MemoryCredentialStore implements CredentialStore {
  private readonly encryption = new CredentialEncryptionService();
  private readonly records = new Map<string, ProviderCredentialRecord>();

  constructor(
    private readonly userId: string,
    private readonly workspaceId: string,
    private readonly masterKey: string,
    private readonly keyVersion: string,
    private readonly previousMasterKey?: string,
  ) {}

  async getCredential(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null> {
    return this.cloneRecord(this.findActive(providerId));
  }

  async getCredentialWithKey(
    providerId: ProviderId,
  ): Promise<{ record: ProviderCredentialRecord; apiKey: string } | null> {
    const record = this.findActive(providerId);
    if (!record) {
      return null;
    }

    const encrypted = EncryptedSecretSchema.parse(
      JSON.parse(record.encryptedSecretJson) as unknown,
    );
    const apiKey = await this.encryption.decrypt(encrypted, {
      masterKey: this.masterKey,
      previousMasterKey: this.previousMasterKey,
    });

    return { record: { ...record }, apiKey };
  }

  async setCredential(
    input: SetCredentialInput,
  ): Promise<ProviderCredentialRecord> {
    if (!this.encryption.isValidKeyFormat(input.apiKey)) {
      throw new Error("Invalid API key format");
    }

    const existing = this.findActive(input.providerId);
    const now = new Date().toISOString();
    const encrypted = await this.encryption.encrypt(input.apiKey, {
      masterKey: this.masterKey,
      keyVersion: this.keyVersion,
    });
    const record = await this.buildRecord(input, existing, encrypted, now);

    this.records.set(this.key(input.providerId), record);
    return { ...record };
  }

  async deleteCredential(providerId: ProviderId): Promise<void> {
    const existing = this.findActive(providerId);
    if (!existing) {
      return;
    }

    const now = new Date().toISOString();
    this.records.set(this.key(providerId), {
      ...existing,
      status: "revoked",
      updatedAt: now,
      deletedAt: now,
    });
  }

  async listCredentialProviders(): Promise<ProviderId[]> {
    return [...this.records.values()]
      .filter((record) => record.deletedAt === null)
      .map((record) => record.providerId)
      .sort();
  }

  async updateCredentialMetadata(
    providerId: ProviderId,
    updates: Parameters<CredentialStore["updateCredentialMetadata"]>[1],
  ): Promise<void> {
    const existing = this.findActive(providerId);
    if (!existing) {
      return;
    }

    this.records.set(this.key(providerId), {
      ...existing,
      status: updates.status ?? existing.status,
      lastValidatedAt:
        updates.lastValidatedAt !== undefined
          ? updates.lastValidatedAt
          : existing.lastValidatedAt,
      lastErrorCode:
        updates.lastErrorCode !== undefined
          ? updates.lastErrorCode
          : existing.lastErrorCode,
      lastErrorMessage:
        updates.lastErrorMessage !== undefined
          ? updates.lastErrorMessage
          : existing.lastErrorMessage,
      updatedAt: new Date().toISOString(),
    });
  }

  private async buildRecord(
    input: SetCredentialInput,
    existing: ProviderCredentialRecord | null,
    encrypted: unknown,
    now: string,
  ): Promise<ProviderCredentialRecord> {
    return {
      credentialId:
        existing?.credentialId ?? input.credentialId ?? crypto.randomUUID(),
      userId: this.userId,
      workspaceId: input.workspaceId ?? this.workspaceId,
      providerId: input.providerId,
      label: input.label,
      keyFingerprint: await this.encryption.generateFingerprint(input.apiKey),
      encryptedSecretJson: JSON.stringify(encrypted),
      connectionConfig: input.connectionConfig,
      keyVersion: this.keyVersion,
      status: "connected",
      lastValidatedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  private findActive(providerId: ProviderId): ProviderCredentialRecord | null {
    const record = this.records.get(this.key(providerId));
    return record && record.deletedAt === null ? record : null;
  }

  private cloneRecord(
    record: ProviderCredentialRecord | null,
  ): ProviderCredentialRecord | null {
    return record ? { ...record } : null;
  }

  private key(providerId: ProviderId): string {
    return `${this.userId}:${providerId}`;
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
