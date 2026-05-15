import type { ProviderId } from "@repo/shared-types";
import type { SqlClient, SqlRow, SqlValue } from "../sql.js";
import {
  CredentialEncryptionService,
  type EncryptedSecret,
} from "./credential-encryption.js";
import type {
  CredentialStore,
  ProviderCredentialRecord,
  SetCredentialInput,
} from "./types.js";
import { parseJsonColumn, stringifyJsonColumn } from "./json.js";

interface CredentialRow extends SqlRow {
  id: string;
  user_id: string;
  workspace_id: string;
  provider_id: string;
  label: string;
  key_fingerprint: string;
  encrypted_secret_json: unknown;
  key_version: string;
  status: string;
  last_validated_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class PostgresCredentialStore implements CredentialStore {
  private readonly encryption = new CredentialEncryptionService();

  constructor(
    private readonly client: SqlClient,
    private readonly userId: string,
    private readonly workspaceId: string,
    private readonly masterKey: string,
    private readonly keyVersion: string,
    private readonly previousMasterKey?: string,
  ) {}

  async getCredential(
    providerId: ProviderId,
  ): Promise<ProviderCredentialRecord | null> {
    const result = await this.client.query<CredentialRow>(
      GET_CREDENTIAL_SQL,
      [this.userId, providerId],
    );
    const row = result.rows[0];
    return row ? this.rowToRecord(row) : null;
  }

  async getCredentialWithKey(
    providerId: ProviderId,
  ): Promise<{ record: ProviderCredentialRecord; apiKey: string } | null> {
    const result = await this.client.query<CredentialRow>(
      GET_CREDENTIAL_SQL,
      [this.userId, providerId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const encrypted = readEncryptedSecret(row.encrypted_secret_json);
    const apiKey = await this.encryption.decrypt(encrypted, {
      masterKey: this.masterKey,
      previousMasterKey: this.previousMasterKey,
    });

    return {
      record: this.rowToRecord(row),
      apiKey,
    };
  }

  async setCredential(input: SetCredentialInput): Promise<ProviderCredentialRecord> {
    const credentialId = input.credentialId || crypto.randomUUID();
    const now = new Date().toISOString();

    if (!this.encryption.isValidKeyFormat(input.apiKey)) {
      throw new Error("Invalid API key format");
    }

    const encrypted = await this.encryption.encrypt(input.apiKey, {
      keyVersion: this.keyVersion,
      masterKey: this.masterKey,
    });
    const fingerprint = this.encryption.generateFingerprint(input.apiKey);
    const workspaceId = input.workspaceId || this.workspaceId;

    const result = await this.client.query<CredentialRow>(
      UPSERT_CREDENTIAL_SQL,
      [
        credentialId,
        this.userId,
        workspaceId,
        input.providerId,
        input.label,
        fingerprint,
        JSON.stringify(encrypted),
        this.keyVersion,
        "connected",
        input.createdBy || this.userId,
        now,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create credential");
    }

    return this.rowToRecord(row);
  }

  async deleteCredential(providerId: ProviderId): Promise<void> {
    await this.client.query(DELETE_CREDENTIAL_SQL, [
      new Date().toISOString(),
      this.userId,
      providerId,
    ] as readonly SqlValue[]);
  }

  async listCredentialProviders(): Promise<ProviderId[]> {
    const result = await this.client.query<{ provider_id: string }>(
      LIST_PROVIDER_IDS_SQL,
      [this.userId],
    );
    return result.rows.map((row) => row.provider_id as ProviderId);
  }

  async updateCredentialMetadata(
    providerId: ProviderId,
    updates: {
      status?: "connected" | "failed" | "revoked";
      lastValidatedAt?: string | null;
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
    },
  ): Promise<void> {
    const setClauses: string[] = ["updated_at = $2"];
    const params: SqlValue[] = [this.userId, new Date().toISOString()];

    if (updates.status) {
      setClauses.push(`status = $${params.length + 1}`);
      params.push(updates.status);
    }
    if (updates.lastValidatedAt !== undefined) {
      setClauses.push(`last_validated_at = $${params.length + 1}`);
      params.push(updates.lastValidatedAt);
    }
    if (updates.lastErrorCode !== undefined) {
      setClauses.push(`last_error_code = $${params.length + 1}`);
      params.push(updates.lastErrorCode);
    }
    if (updates.lastErrorMessage !== undefined) {
      setClauses.push(`last_error_message = $${params.length + 1}`);
      params.push(updates.lastErrorMessage);
    }

    params.push(providerId);

    await this.client.query(
      `
        UPDATE provider_credentials
        SET ${setClauses.join(", ")}
        WHERE user_id = $1
          AND provider_id = $${params.length}
          AND deleted_at IS NULL
      `,
      params,
    );
  }

  private rowToRecord(row: CredentialRow): ProviderCredentialRecord {
    return {
      credentialId: row.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      providerId: row.provider_id as ProviderId,
      label: row.label,
      keyFingerprint: row.key_fingerprint,
      encryptedSecretJson: stringifyJsonColumn(row.encrypted_secret_json),
      keyVersion: row.key_version,
      status: row.status as "connected" | "failed" | "revoked",
      lastValidatedAt: row.last_validated_at,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }
}

function readEncryptedSecret(value: unknown): EncryptedSecret {
  const parsed = parseJsonColumn(value, "encrypted secret payload");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid encrypted secret payload");
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.ciphertext !== "string" ||
    typeof record.iv !== "string" ||
    typeof record.tag !== "string" ||
    typeof record.keyVersion !== "string"
  ) {
    throw new Error("Invalid encrypted secret payload");
  }

  return {
    alg: "AES-256-GCM",
    ciphertext: record.ciphertext,
    iv: record.iv,
    tag: record.tag,
    keyVersion: record.keyVersion,
  };
}

const GET_CREDENTIAL_SQL = `
  SELECT
    id,
    user_id,
    workspace_id,
    provider_id,
    label,
    key_fingerprint,
    encrypted_secret_json,
    key_version,
    status,
    last_validated_at,
    last_error_code,
    last_error_message,
    created_by,
    created_at,
    updated_at,
    deleted_at
  FROM provider_credentials
  WHERE user_id = $1
    AND provider_id = $2
    AND deleted_at IS NULL
  LIMIT 1
`;

const UPSERT_CREDENTIAL_SQL = `
  INSERT INTO provider_credentials (
    id,
    user_id,
    workspace_id,
    provider_id,
    label,
    key_fingerprint,
    encrypted_secret_json,
    key_version,
    status,
    created_by,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $11)
  ON CONFLICT (user_id, provider_id, label)
  WHERE deleted_at IS NULL
  DO UPDATE SET
    encrypted_secret_json = EXCLUDED.encrypted_secret_json,
    key_version = EXCLUDED.key_version,
    key_fingerprint = EXCLUDED.key_fingerprint,
    status = 'connected',
    last_validated_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL
  RETURNING
    id,
    user_id,
    workspace_id,
    provider_id,
    label,
    key_fingerprint,
    encrypted_secret_json,
    key_version,
    status,
    last_validated_at,
    last_error_code,
    last_error_message,
    created_by,
    created_at,
    updated_at,
    deleted_at
`;

const DELETE_CREDENTIAL_SQL = `
  UPDATE provider_credentials
  SET deleted_at = $1,
      updated_at = $1
  WHERE user_id = $2
    AND provider_id = $3
    AND deleted_at IS NULL
`;

const LIST_PROVIDER_IDS_SQL = `
  SELECT DISTINCT provider_id
  FROM provider_credentials
  WHERE user_id = $1
    AND deleted_at IS NULL
  ORDER BY provider_id
`;
