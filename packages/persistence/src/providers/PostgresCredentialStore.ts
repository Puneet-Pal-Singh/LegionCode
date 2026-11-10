import { PostgresPreferenceStore } from "./PostgresPreferenceStore.js";
import { PostgresCredentialDefaultFence } from "./PostgresCredentialDefaultFence.js";
import {
  CredentialAcquisitionSchema,
  CredentialSecretSchema,
  ProviderConnectionConfigSchema,
  ProviderIdSchema,
  type CredentialAcquisition,
  type CredentialRefreshClaim,
  type CredentialSecret,
  type ProviderId,
} from "@repo/shared-types";
import type { SqlClient, SqlRow, SqlValue } from "../sql.js";
import { CredentialEncryptionService } from "./credential-encryption.js";
import {
  acquisition,
  matches,
  sameOAuthAccount,
  ConnectionSecretCodec,
  snapshotReconnectInput,
  assertReconnectOwner,
  CredentialReconnectConflict,
} from "./connection-custody.js";
import type {
  CredentialStore,
  PreferenceStore,
  CredentialConnectionStore,
  CreateCredentialConnectionInput,
  ProviderCredentialRecord,
  SetCredentialInput,
} from "./types.js";
import { parseJsonColumn, stringifyJsonColumn } from "./json.js";

export class PostgresCredentialStore
  implements CredentialStore, CredentialConnectionStore
{
  private readonly encryption = new CredentialEncryptionService();
  private readonly codec: ConnectionSecretCodec;
  constructor(
    private readonly client: SqlClient,
    private readonly userId: string,
    private readonly workspaceId: string,
    private readonly masterKey: string,
    private readonly keyVersion: string,
    private readonly previousMasterKey?: string,
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
      !(preferences instanceof PostgresPreferenceStore) ||
      !preferences.ownsCredentialScope(
        this.client,
        this.userId,
        this.workspaceId,
      )
    )
      throw new Error(
        "Credential reconnect requires canonical preference ownership",
      );
    if (!this.encryption.isValidKeyFormat(input.apiKey))
      throw new Error("Invalid API key format");
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
    const isDefault = !bindSelection;
    const epoch = isDefault
      ? await new PostgresCredentialDefaultFence(this.client).capture({
          userId: this.userId,
          providerId: input.providerId,
        })
      : undefined;
    // New identity/AAD; never revive the selected tombstone or replace an
    // unrelated default. All encryption completes BEFORE the SQL transaction.
    const prepared = this.newRecord(input, crypto.randomUUID(), isDefault);
    prepared.encryptedSecretJson = await this.codec.encode(
      { type: "api_key", apiKey: input.apiKey },
      prepared,
    );
    prepared.keyFingerprint = await this.encryption.generateFingerprint(
      input.apiKey,
    );
    try {
      return await preferences.withCredentialSelection(
        selection,
        async (client) => {
          const store = this.withClient(client);
          const committed = await new PostgresCredentialDefaultFence(
            client,
          ).advanceInTransaction(
            { userId: this.userId, providerId: prepared.providerId },
            async () => {
              if (epoch !== undefined) {
                const currentEpoch = await client.query<{
                  generation: string | number;
                }>(
                  "SELECT generation FROM provider_credential_default_epochs WHERE user_id=$1 AND provider_id=$2",
                  [this.userId, prepared.providerId],
                );
                if (Number(currentEpoch.rows[0]?.generation) !== epoch + 1)
                  throw new CredentialReconnectConflict();
              }
              const current = owner
                ? await store.getConnection(owner.credentialId)
                : await store.getCredential(prepared.providerId);
              assertReconnectOwner(
                current,
                owner,
                this.userId,
                prepared.providerId,
              );
              if (owner && owner.deletedAt === null) {
                if (
                  !(await store.revokeConnectionInTransaction(
                    acquisition(owner),
                  ))
                )
                  throw new CredentialReconnectConflict();
              }
              const inserted = await store.insert(prepared);
              if (bindSelection)
                await new PostgresPreferenceStore(
                  client,
                  this.userId,
                  this.workspaceId,
                ).bindCredentialSelection(selection, inserted.credentialId);
              return inserted;
            },
          );
          return committed.value;
        },
      );
    } catch (error) {
      if (error instanceof CredentialReconnectConflict) throw error;
      // A transport error can occur AFTER COMMIT. Never retry with a fresh UUID
      // or claim rollback; the next explicit action must reconcile durable state.
      throw new Error(
        "Credential connection outcome is unknown; reconcile before retrying",
      );
    }
  }

  async getCredential(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null> {
    return this.read(
      "provider_id = $2 AND is_default = TRUE AND deleted_at IS NULL",
      [providerId],
    );
  }
  async getConnection(
    connectionId: string,
  ): Promise<ProviderCredentialRecord | null> {
    return this.read("id = $2", [connectionId]);
  }
  async getCredentialWithKey(
    providerId: ProviderId,
  ): Promise<{ record: ProviderCredentialRecord; apiKey: string } | null> {
    let record = await this.getCredential(providerId);
    if (
      !record ||
      !matches(record, acquisition(record)) ||
      record.credentialKind !== "api_key" ||
      record.refreshClaimId
    )
      return null;
    // This is the explicit legacy API-key migration path. Typed acquisitions never accept unbound ciphertext.
    const secret = await this.codec.decode(record, true);
    if (secret.type !== "api_key") return null;
    if (!this.codec.isLegacy(record)) {
      const current = await this.getConnection(record.credentialId);
      if (!matches(current, acquisition(record)) || current.refreshClaimId)
        return null;
      return { record: current, apiKey: secret.apiKey };
    }
    const encoded = await this.codec.encode(secret, record);
    const migrated = await this.update(
      record,
      "encrypted_secret_json = $7::jsonb, key_version = $8",
      [encoded, this.keyVersion],
      "AND encrypted_secret_json = $9::jsonb",
      [record.encryptedSecretJson],
    );
    if (!migrated) return null;
    record = migrated;
    return { record, apiKey: secret.apiKey };
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
    const fence = new PostgresCredentialDefaultFence(this.client);
    const scope = { userId: this.userId, providerId: input.providerId };
    // Capture the durable slot generation before an absent lookup or encryption.
    const epoch = await fence.capture(scope);
    const before = await this.getCredential(input.providerId);
    if (
      captured &&
      (!before ||
        before.credentialId !== captured.connectionId ||
        before.authOwnerGeneration !== captured.ownerGeneration ||
        before.tokenMaterialVersion !== captured.tokenMaterialVersion)
    )
      throw new Error("Credential changed during reconnect");
    const existing = before?.status === "revoked" ? null : before;
    const record = this.newRecord(
      input,
      input.credentialId ?? crypto.randomUUID(),
      true,
    );
    if (existing) {
      record.credentialId = existing.credentialId;
      record.authOwnerGeneration = existing.authOwnerGeneration + 1;
      record.tokenMaterialVersion = existing.tokenMaterialVersion + 1;
      record.createdAt = existing.createdAt;
    }
    record.encryptedSecretJson = await this.codec.encode(
      { type: "api_key", apiKey: input.apiKey },
      record,
    );
    record.keyFingerprint = await this.encryption.generateFingerprint(
      input.apiKey,
    );
    const committed = await fence.commitIfCurrent(
      scope,
      epoch,
      async (client) => {
        const store = this.withClient(client);
        if (captured) {
          const current = await store.getCredential(input.providerId);
          if (
            !current ||
            current.credentialId !== captured.connectionId ||
            current.authOwnerGeneration !== captured.ownerGeneration ||
            current.tokenMaterialVersion !== captured.tokenMaterialVersion
          )
            throw new Error("Credential changed during reconnect");
        }
        if (before?.status === "revoked") {
          // Retire a legacy metadata-only revocation without reconnecting its ID.
          const retired = await store.revokeConnectionInTransaction(
            acquisition(before),
          );
          if (!retired)
            throw new Error("Credential ownership changed during reconnection");
        }
        if (!existing) return store.insert(record);
        const updated = await store.update(
          existing,
          "encrypted_secret_json = $7::jsonb, auth_owner_generation = $8, token_material_version = $9, key_version = $10, key_fingerprint = $11, label = $12, connection_config_json = $13::jsonb, refresh_claim_id = NULL, status = 'connected', credential_kind = 'api_key', last_validated_at = NULL, last_error_code = NULL, last_error_message = NULL",
          [
            record.encryptedSecretJson,
            record.authOwnerGeneration,
            record.tokenMaterialVersion,
            record.keyVersion,
            record.keyFingerprint,
            record.label,
            record.connectionConfig
              ? JSON.stringify(record.connectionConfig)
              : null,
          ],
        );
        if (!updated)
          throw new Error(
            "Credential replacement conflicted with revocation or rotation",
          );
        return updated;
      },
    );
    if (committed.status === "conflict")
      throw new Error("Credential default changed during connection");
    return committed.value;
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
    const record = this.newRecord(input, crypto.randomUUID(), false);
    record.credentialKind = secret.type;
    record.encryptedSecretJson = await this.codec.encode(secret, record);
    record.keyFingerprint =
      secret.type === "api_key"
        ? await this.encryption.generateFingerprint(secret.apiKey)
        : "unavailable";
    return this.insert(record);
  }
  async acquireConnection(expected: CredentialAcquisition): Promise<{
    record: ProviderCredentialRecord;
    secret: CredentialSecret;
  } | null> {
    expected = CredentialAcquisitionSchema.parse(expected);
    this.authorize(expected.userId);
    const record = await this.getConnection(expected.connectionId);
    if (!matches(record, expected) || record.refreshClaimId) return null;
    const secret = await this.codec.decode(record);
    const current = await this.getConnection(expected.connectionId);
    if (!matches(current, expected) || current.refreshClaimId) return null;
    return { record: current, secret };
  }
  async claimRefresh(expected: CredentialAcquisition) {
    expected = CredentialAcquisitionSchema.parse(expected);
    this.authorize(expected.userId);
    const before = await this.getConnection(expected.connectionId);
    if (
      !matches(before, expected) ||
      before.credentialKind !== "oauth" ||
      before.refreshClaimId
    )
      return null;
    const refreshClaimId = crypto.randomUUID();
    const record = await this.update(
      before,
      "refresh_claim_id = $7",
      [refreshClaimId],
      "AND refresh_claim_id IS NULL",
    );
    if (!record) return null;
    const secret = await this.codec.decode(record);
    const current = await this.getConnection(expected.connectionId);
    if (
      !matches(current, expected) ||
      current.refreshClaimId !== refreshClaimId ||
      secret.type !== "oauth"
    )
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
    const before = await this.getConnection(claim.connectionId);
    if (
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
    };
    const encoded = await this.codec.encode(parsed, next);
    return this.update(
      before,
      "encrypted_secret_json = $7::jsonb, token_material_version = $8, key_version = $9, refresh_claim_id = NULL",
      [encoded, next.tokenMaterialVersion, this.keyVersion],
      "AND refresh_claim_id = $10",
      [claim.refreshClaimId],
    );
  }
  async revokeConnection(
    expected: CredentialAcquisition,
  ): Promise<ProviderCredentialRecord | null> {
    expected = CredentialAcquisitionSchema.parse(expected);
    this.authorize(expected.userId);
    const fence = new PostgresCredentialDefaultFence(this.client);
    const mismatch = new Error("Credential revocation ownership changed");
    try {
      const result = await fence.advance(
        { userId: this.userId, providerId: expected.providerId },
        async (client) => {
          const revoked =
            await this.withClient(client).revokeConnectionInTransaction(
              expected,
            );
          if (!revoked) throw mismatch; // Roll back the epoch on a failed CAS.
          return revoked;
        },
      );
      return result.value;
    } catch (error) {
      if (error === mismatch) return null;
      throw error;
    }
  }
  /** Caller already owns the durable default-slot fence on this transaction. */
  private async revokeConnectionInTransaction(
    expected: CredentialAcquisition,
  ): Promise<ProviderCredentialRecord | null> {
    const result = await this.client.query<SqlRow>(
      `UPDATE provider_credentials SET status = 'revoked', deleted_at = $5, updated_at = $5, auth_owner_generation = auth_owner_generation + 1, refresh_claim_id = NULL, encrypted_secret_json = '{}'::jsonb, is_default = FALSE WHERE user_id = $1 AND id = $2 AND provider_id = $3 AND auth_owner_generation = $4 AND deleted_at IS NULL RETURNING *`,
      [
        this.userId,
        expected.connectionId,
        expected.providerId,
        expected.ownerGeneration,
        new Date().toISOString(),
      ],
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
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
    const fence = new PostgresCredentialDefaultFence(this.client);
    // Advance even for an absent slot; revoke and epoch advance commit together.
    await fence.advance({ userId: this.userId, providerId }, async (client) => {
      const store = this.withClient(client);
      const record = await store.getCredential(providerId);
      if (
        captured &&
        (!record ||
          record.credentialId !== captured.connectionId ||
          record.authOwnerGeneration !== captured.ownerGeneration ||
          record.tokenMaterialVersion !== captured.tokenMaterialVersion)
      )
        throw new Error("Credential changed during disconnect");
      if (record) {
        const revoked = await store.revokeConnectionInTransaction(
          acquisition(record),
        );
        if (captured && !revoked)
          throw new Error("Credential changed during disconnect");
      }
    });
  }
  private withClient(client: SqlClient): PostgresCredentialStore {
    return new PostgresCredentialStore(
      client,
      this.userId,
      this.workspaceId,
      this.masterKey,
      this.keyVersion,
      this.previousMasterKey,
    );
  }
  async listCredentialProviders(): Promise<ProviderId[]> {
    const result = await this.client.query<{ provider_id: string }>(
      "SELECT DISTINCT provider_id FROM provider_credentials WHERE user_id = $1 AND status = 'connected' AND deleted_at IS NULL ORDER BY provider_id",
      [this.userId],
    );
    return result.rows.map((row) => row.provider_id);
  }
  async updateCredentialMetadata(
    providerId: ProviderId,
    updates: Parameters<CredentialStore["updateCredentialMetadata"]>[1],
  ): Promise<void> {
    updates = { ...updates };
    if (updates.status === "revoked") return this.deleteCredential(providerId);
    const record = await this.getCredential(providerId);
    if (!record || record.status !== "connected") return;
    await this.update(
      record,
      "status = $7, last_validated_at = $8, last_error_code = $9, last_error_message = $10",
      [
        updates.status ?? record.status,
        updates.lastValidatedAt !== undefined
          ? updates.lastValidatedAt
          : record.lastValidatedAt,
        updates.lastErrorCode !== undefined
          ? updates.lastErrorCode
          : record.lastErrorCode,
        updates.lastErrorMessage !== undefined
          ? updates.lastErrorMessage
          : record.lastErrorMessage,
      ],
    );
  }
  private authorize(userId: string) {
    if (!userId || userId !== this.userId)
      throw new Error("Credential scope mismatch");
  }
  private async read(
    predicate: string,
    values: SqlValue[],
  ): Promise<ProviderCredentialRecord | null> {
    const result = await this.client.query<SqlRow>(
      `SELECT * FROM provider_credentials WHERE user_id = $1 AND ${predicate} LIMIT 1`,
      [this.userId, ...values],
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }
  private async update(
    before: ProviderCredentialRecord,
    set: string,
    values: SqlValue[],
    extra = "",
    extraValues: SqlValue[] = [],
  ): Promise<ProviderCredentialRecord | null> {
    const result = await this.client.query<SqlRow>(
      `UPDATE provider_credentials SET ${set}, updated_at = $6 WHERE user_id = $1 AND id = $2 AND auth_owner_generation = $3 AND token_material_version = $4 AND status = $5 AND status <> 'revoked' AND deleted_at IS NULL ${extra} RETURNING *`,
      [
        this.userId,
        before.credentialId,
        before.authOwnerGeneration,
        before.tokenMaterialVersion,
        before.status,
        new Date().toISOString(),
        ...values,
        ...extraValues,
      ],
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }
  private newRecord(
    input: {
      providerId: ProviderId;
      label: string;
      connectionConfig?: ProviderCredentialRecord["connectionConfig"];
    },
    connectionId: string,
    isDefault: boolean,
  ): ProviderCredentialRecord {
    const connectionConfig = input.connectionConfig
      ? ProviderConnectionConfigSchema.parse(input.connectionConfig)
      : undefined;
    if (connectionConfig && connectionConfig.providerId !== input.providerId)
      throw new Error("Credential configuration scope mismatch");
    const now = new Date().toISOString();
    return {
      credentialId: connectionId,
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
  private async insert(
    r: ProviderCredentialRecord,
  ): Promise<ProviderCredentialRecord> {
    const result = await this.client.query<SqlRow>(
      `INSERT INTO provider_credentials (id,user_id,workspace_id,provider_id,label,key_fingerprint,encrypted_secret_json,connection_config_json,key_version,status,created_by,created_at,updated_at,auth_owner_generation,token_material_version,credential_kind,refresh_claim_id,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$12,$13,$14,$15,NULL,$16) RETURNING *`,
      [
        r.credentialId,
        r.userId,
        r.workspaceId,
        r.providerId,
        r.label,
        r.keyFingerprint,
        r.encryptedSecretJson,
        r.connectionConfig ? JSON.stringify(r.connectionConfig) : null,
        r.keyVersion,
        r.status,
        r.userId,
        r.createdAt,
        r.authOwnerGeneration,
        r.tokenMaterialVersion,
        r.credentialKind,
        r.isDefault,
      ],
    );
    if (!result.rows[0]) throw new Error("Credential creation failed");
    return this.rowToRecord(result.rows[0]);
  }
  private rowToRecord(row: SqlRow): ProviderCredentialRecord {
    const integer = (v: unknown): number => {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error("Invalid credential generation");
      return n;
    };
    const config =
      row.connection_config_json == null
        ? undefined
        : ProviderConnectionConfigSchema.parse(
            parseJsonColumn(row.connection_config_json, "connection config"),
          );
    const kind = row.credential_kind;
    if (kind !== "api_key" && kind !== "oauth" && kind !== "external_reference")
      throw new Error("Invalid credential kind");
    const status = row.status;
    if (status !== "connected" && status !== "failed" && status !== "revoked")
      throw new Error("Invalid credential status");
    if (row.user_id !== this.userId || typeof row.is_default !== "boolean")
      throw new Error("Credential scope mismatch");
    return {
      credentialId: String(row.id),
      userId: String(row.user_id),
      workspaceId: String(row.workspace_id),
      providerId: String(row.provider_id),
      label: String(row.label),
      authOwnerGeneration: integer(row.auth_owner_generation),
      tokenMaterialVersion: integer(row.token_material_version),
      credentialKind: kind,
      refreshClaimId:
        row.refresh_claim_id == null ? null : String(row.refresh_claim_id),
      isDefault: row.is_default,
      keyFingerprint: String(row.key_fingerprint),
      encryptedSecretJson: stringifyJsonColumn(row.encrypted_secret_json),
      connectionConfig: config,
      keyVersion: String(row.key_version),
      status,
      lastValidatedAt: nullable(row.last_validated_at),
      lastErrorCode: nullable(row.last_error_code),
      lastErrorMessage: nullable(row.last_error_message),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: nullable(row.deleted_at),
    };
  }
}
function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
