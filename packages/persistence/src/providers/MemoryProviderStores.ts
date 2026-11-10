import {
  CredentialSecretSchema,
  CredentialAcquisitionSchema,
  ProviderConnectionConfigSchema,
  ProviderIdSchema,
  type CredentialAcquisition,
  type CredentialRefreshClaim,
  type CredentialSecret,
} from "@repo/shared-types";
import {
  ConnectionSecretCodec,
  acquisition,
  matches,
  sameOAuthAccount,
  snapshotReconnectInput,
  assertReconnectOwner,
  CredentialReconnectConflict,
} from "./connection-custody.js";
import type {
  BYOKPreferences,
  BYOKPreferencesPatch,
  ProviderId,
} from "@repo/shared-types";
import { CredentialEncryptionService } from "./credential-encryption.js";
import type {
  CredentialConnectionStore,
  CredentialSelectionSnapshot,
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
  async reconnectCredential(
    input: SetCredentialInput,
    preferences: PreferenceStore,
  ): Promise<ProviderCredentialRecord> {
    input = snapshotReconnectInput(input);
    this.authorize(input.userId);
    if (
      !(preferences instanceof MemoryPreferenceStore) ||
      !preferences.ownsCredentialScope(this.userId, this.workspaceId)
    )
      throw new Error(
        "Credential reconnect requires canonical preference ownership",
      );
    if (!this.encryption.isValidKeyFormat(input.apiKey))
      throw new Error("Invalid API key format");
    // Same ordering as PostgreSQL: fence every intent before its first await.
    const epoch = this.epochs.get(input.providerId) ?? 0;
    const selection = await preferences.captureCredentialSelection();
    const bindSelection = selection.providerId === input.providerId;
    const selectedId = bindSelection ? selection.credentialId : undefined;
    const before =
      selectedId !== undefined
        ? await this.getConnection(selectedId)
        : await this.getCredential(input.providerId);
    if (selectedId !== undefined && !before)
      throw new CredentialReconnectConflict();
    if (
      before &&
      (before.userId !== this.userId ||
        before.providerId !== input.providerId ||
        before.credentialKind !== "api_key" ||
        before.refreshClaimId !== null ||
        (before.deletedAt !== null && before.status !== "revoked"))
    )
      throw new CredentialReconnectConflict();
    const owner = before ? structuredClone(before) : null;
    const prepared = this.newRecord(input, crypto.randomUUID(), !bindSelection);
    prepared.encryptedSecretJson = await this.codec.encode(
      { type: "api_key", apiKey: input.apiKey },
      prepared,
    );
    prepared.keyFingerprint = await this.encryption.generateFingerprint(
      input.apiKey,
    );
    try {
      return preferences.commitCredentialSelection(
        selection,
        bindSelection ? prepared.credentialId : undefined,
        () => {
          // All validation/allocation precedes the synchronous final mutation.
          // No await can expose a new credential without its preference binding.
          if ((this.epochs.get(input.providerId) ?? 0) !== epoch)
            throw new CredentialReconnectConflict();
          const current = owner
            ? (this.records.get(owner.credentialId) ?? null)
            : this.findDefault(input.providerId);
          assertReconnectOwner(current, owner, this.userId, input.providerId);
          if (this.records.has(prepared.credentialId))
            throw new CredentialReconnectConflict();
          const nextEpoch = (this.epochs.get(input.providerId) ?? 0) + 1;
          if (
            !Number.isSafeInteger(nextEpoch) ||
            (owner &&
              owner.deletedAt === null &&
              !Number.isSafeInteger(owner.authOwnerGeneration + 1))
          )
            throw new CredentialReconnectConflict();
          const now = new Date().toISOString();
          const retired =
            owner && owner.deletedAt === null
              ? {
                  ...owner,
                  authOwnerGeneration: owner.authOwnerGeneration + 1,
                  status: "revoked" as const,
                  deletedAt: now,
                  updatedAt: now,
                  encryptedSecretJson: "{}",
                  refreshClaimId: null,
                  isDefault: false,
                }
              : null;
          const result = structuredClone(prepared);
          if (retired) this.records.set(retired.credentialId, retired);
          this.records.set(prepared.credentialId, prepared);
          this.epochs.set(input.providerId, nextEpoch);
          return result;
        },
      );
    } catch (error) {
      if (error instanceof CredentialReconnectConflict) throw error;
      throw new Error(
        "Credential connection outcome is unknown; reconcile before retrying",
      );
    }
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
    expected?: CredentialAcquisition,
  ): Promise<ProviderCredentialRecord> {
    input = {
      ...input,
      providerId: ProviderIdSchema.parse(input.providerId),
      connectionConfig: input.connectionConfig
        ? ProviderConnectionConfigSchema.parse(input.connectionConfig)
        : undefined,
    };
    this.authorize(input.userId);
    const captured = expected
      ? CredentialAcquisitionSchema.parse(expected)
      : undefined;
    if (
      captured &&
      (captured.userId !== this.userId ||
        captured.providerId !== input.providerId)
    )
      throw new Error("Credential reconnect scope mismatch");
    if (!this.encryption.isValidKeyFormat(input.apiKey))
      throw new Error("Invalid API key format");
    const before = this.findDefault(input.providerId);
    if (
      captured &&
      (!before ||
        before.credentialId !== captured.connectionId ||
        before.authOwnerGeneration !== captured.ownerGeneration ||
        before.tokenMaterialVersion !== captured.tokenMaterialVersion)
    )
      throw new Error("Credential changed during reconnect");
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
    input = {
      ...input,
      providerId: ProviderIdSchema.parse(input.providerId),
      secret: CredentialSecretSchema.parse(input.secret),
      connectionConfig: input.connectionConfig
        ? ProviderConnectionConfigSchema.parse(input.connectionConfig)
        : undefined,
    };
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
    expected = CredentialAcquisitionSchema.parse(expected);
    this.authorize(expected.userId);
    const before = this.records.get(expected.connectionId);
    if (!before || !matches(before, expected) || before.refreshClaimId)
      return null;
    const secret = await this.codec.decode(before);
    if (this.records.get(expected.connectionId) !== before) return null;
    return { record: structuredClone(before), secret };
  }
  async claimRefresh(expected: CredentialAcquisition) {
    expected = CredentialAcquisitionSchema.parse(expected);
    this.authorize(expected.userId);
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
    const { refreshClaimId, ...owner } = claim;
    claim = {
      ...CredentialAcquisitionSchema.parse(owner),
      refreshClaimId:
        CredentialAcquisitionSchema.shape.connectionId.parse(refreshClaimId),
    };
    const parsed = CredentialSecretSchema.parse(secret);
    this.authorize(claim.userId);
    const before = this.records.get(claim.connectionId);
    if (
      !before ||
      !matches(before, claim) ||
      before.refreshClaimId !== claim.refreshClaimId
    )
      return null;
    const previous = await this.codec.decode(before);
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
    expected = CredentialAcquisitionSchema.parse(expected);
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
  async deleteCredential(
    providerId: ProviderId,
    expected?: CredentialAcquisition,
  ): Promise<void> {
    const captured = expected
      ? CredentialAcquisitionSchema.parse(expected)
      : undefined;
    if (
      captured &&
      (captured.userId !== this.userId || captured.providerId !== providerId)
    )
      throw new Error("Credential disconnect scope mismatch");
    const before = this.findDefault(providerId);
    if (
      captured &&
      (!before ||
        before.credentialId !== captured.connectionId ||
        before.authOwnerGeneration !== captured.ownerGeneration ||
        before.tokenMaterialVersion !== captured.tokenMaterialVersion)
    )
      throw new Error("Credential changed during disconnect");
    this.epochs.set(providerId, (this.epochs.get(providerId) ?? 0) + 1);
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
    updates = { ...updates };
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

interface MemoryPreferenceState {
  readonly value: BYOKPreferences;
  readonly version: number;
}
export class MemoryPreferenceStore implements PreferenceStore {
  constructor(
    private readonly userId: string,
    private readonly workspaceId: string,
    private readonly preferences = new Map<string, MemoryPreferenceState>(),
  ) {}

  ownsCredentialScope(userId: string, workspaceId: string): boolean {
    return userId === this.userId && workspaceId === this.workspaceId;
  }
  async captureCredentialSelection(): Promise<CredentialSelectionSnapshot> {
    const state = this.preferences.get(this.key());
    return {
      providerId: state?.value.defaultProviderId,
      credentialId: state?.value.defaultCredentialId,
      version: state ? String(state.version) : null,
    };
  }
  /** Shared map entry is the version authority, including across wrappers.
   * Final credential and preference map changes execute without an await. */
  commitCredentialSelection<T>(
    expected: CredentialSelectionSnapshot,
    credentialId: string | undefined,
    commit: () => T,
  ): T {
    expected = { ...expected };
    const state = this.preferences.get(this.key());
    if (
      (state ? String(state.version) : null) !== expected.version ||
      state?.value.defaultProviderId !== expected.providerId ||
      state?.value.defaultCredentialId !== expected.credentialId
    )
      throw new CredentialReconnectConflict();
    const next =
      credentialId !== undefined
        ? this.clonePreferences({
            ...(state?.value ?? this.defaultPreferences()),
            defaultCredentialId:
              CredentialAcquisitionSchema.shape.connectionId.parse(
                credentialId,
              ),
            updatedAt: new Date().toISOString(),
          })
        : null;
    const version = (state?.version ?? 0) + 1;
    if (next && (!expected.providerId || !Number.isSafeInteger(version)))
      throw new CredentialReconnectConflict();
    const result = commit();
    if (next) this.preferences.set(this.key(), { value: next, version });
    return result;
  }
  async getPreferences(): Promise<BYOKPreferences> {
    return this.currentPreferences();
  }
  async updatePreferences(
    patch: BYOKPreferencesPatch,
  ): Promise<BYOKPreferences> {
    patch = structuredClone(patch);
    const current = this.currentPreferences();
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
    this.publish(next);
    return this.clonePreferences(next);
  }
  async setCredentialLabel(credentialId: string, label: string): Promise<void> {
    const current = this.currentPreferences();
    this.publish({
      ...current,
      credentialLabels: { ...current.credentialLabels, [credentialId]: label },
      updatedAt: new Date().toISOString(),
    });
  }
  async deleteCredentialLabel(credentialId: string): Promise<void> {
    const current = this.currentPreferences();
    const credentialLabels = { ...current.credentialLabels };
    delete credentialLabels[credentialId];
    this.publish({
      ...current,
      credentialLabels,
      updatedAt: new Date().toISOString(),
    });
  }
  private publish(value: BYOKPreferences): void {
    const version = (this.preferences.get(this.key())?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version))
      throw new Error("Preference version unavailable");
    this.preferences.set(this.key(), {
      value: this.clonePreferences(value),
      version,
    });
  }
  private currentPreferences(): BYOKPreferences {
    return this.clonePreferences(
      this.preferences.get(this.key())?.value ?? this.defaultPreferences(),
    );
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
