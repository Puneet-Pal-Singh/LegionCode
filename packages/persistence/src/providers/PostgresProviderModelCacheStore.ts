import type {
  BYOKDiscoveredProviderModel,
  BYOKModelDiscoverySource,
} from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import type {
  ProviderModelCacheRecord,
  ProviderModelCacheStore,
  UserScopedCacheKey,
} from "./types.js";
import {
  BYOKDiscoveredProviderModelSchema,
} from "@repo/shared-types";
import { parseJsonColumn } from "./json.js";

interface ProviderCacheRow extends SqlRow {
  provider_id: string;
  display_name: string;
  auth_modes_json: unknown;
  capabilities_json: unknown;
  models_json: unknown;
  source_version: string;
  fetched_at: string;
  expires_at: string;
  refreshed_at: string;
}

interface UserCacheRow extends SqlRow {
  user_id: string;
  provider_id: string;
  credential_id: string;
  models_json: unknown;
  source_version: string;
  fetched_at: string;
  expires_at: string;
}

export class PostgresProviderModelCacheStore implements ProviderModelCacheStore {
  constructor(
    private readonly client: SqlClient,
    private readonly userId: string,
  ) {}

  async getModelCache(
    providerId: string,
  ): Promise<ProviderModelCacheRecord | null> {
    const result = await this.client.query<ProviderCacheRow>(
      GET_PROVIDER_CACHE_SQL,
      [providerId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (new Date(row.expires_at) < new Date()) {
      return null;
    }

    try {
      const models = readModels(row.models_json);
      return {
        providerId: row.provider_id,
        models,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
        source: "cache" as BYOKModelDiscoverySource,
      };
    } catch (error) {
      console.error(
        `[PostgresProviderModelCacheStore/getModelCache] Failed to parse cache for provider: ${providerId}`,
        error,
      );
      return null;
    }
  }

  async setModelCache(record: ProviderModelCacheRecord): Promise<void> {
    await this.client.query(UPSERT_PROVIDER_CACHE_SQL, [
      record.providerId,
      record.providerId,
      "[]",
      "{}",
      JSON.stringify(record.models),
      record.source,
      record.fetchedAt,
      record.expiresAt,
      record.fetchedAt,
    ]);
  }

  async invalidateModelCache(providerId: string): Promise<void> {
    await this.client.query(DELETE_PROVIDER_CACHE_SQL, [providerId]);
  }

  async getUserModelCache(
    key: UserScopedCacheKey,
  ): Promise<ProviderModelCacheRecord | null> {
    const result = await this.client.query<UserCacheRow>(
      GET_USER_CACHE_SQL,
      [this.userId, key.providerId, key.credentialId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (new Date(row.expires_at) < new Date()) {
      return null;
    }

    try {
      const models = readModels(row.models_json);
      return {
        providerId: row.provider_id,
        models,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
        source: "cache" as BYOKModelDiscoverySource,
      };
    } catch (error) {
      console.error(
        `[PostgresProviderModelCacheStore/getUserModelCache] Failed to parse cache for ${key.providerId}/${key.credentialId}`,
        error,
      );
      return null;
    }
  }

  async setUserModelCache(
    key: UserScopedCacheKey,
    record: ProviderModelCacheRecord,
  ): Promise<void> {
    if (record.providerId !== key.providerId) {
      throw new Error(
        `[PostgresProviderModelCacheStore/setUserModelCache] providerId mismatch: key=${key.providerId}, record=${record.providerId}`,
      );
    }

    await this.client.query(UPSERT_USER_CACHE_SQL, [
      this.userId,
      key.providerId,
      key.credentialId,
      JSON.stringify(record.models),
      record.source,
      record.fetchedAt,
      record.expiresAt,
    ]);
  }

  async invalidateUserModelCache(key: UserScopedCacheKey): Promise<void> {
    await this.client.query(DELETE_USER_CACHE_SQL, [
      this.userId,
      key.providerId,
      key.credentialId,
    ]);
  }
}

function readModels(value: unknown): BYOKDiscoveredProviderModel[] {
  const parsed = parseJsonColumn(value, "provider model cache");
  return BYOKDiscoveredProviderModelSchema.array().parse(parsed);
}

const GET_PROVIDER_CACHE_SQL = `
  SELECT
    provider_id,
    display_name,
    auth_modes_json,
    capabilities_json,
    models_json,
    source_version,
    fetched_at,
    expires_at,
    refreshed_at
  FROM provider_registry_cache
  WHERE provider_id = $1
  LIMIT 1
`;

const UPSERT_PROVIDER_CACHE_SQL = `
  INSERT INTO provider_registry_cache (
    provider_id,
    display_name,
    auth_modes_json,
    capabilities_json,
    models_json,
    source_version,
    fetched_at,
    expires_at,
    refreshed_at
  )
  VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
  ON CONFLICT (provider_id)
  DO UPDATE SET
    display_name = EXCLUDED.display_name,
    auth_modes_json = EXCLUDED.auth_modes_json,
    capabilities_json = EXCLUDED.capabilities_json,
    models_json = EXCLUDED.models_json,
    source_version = EXCLUDED.source_version,
    fetched_at = EXCLUDED.fetched_at,
    expires_at = EXCLUDED.expires_at,
    refreshed_at = EXCLUDED.refreshed_at
`;

const DELETE_PROVIDER_CACHE_SQL = `
  DELETE FROM provider_registry_cache
  WHERE provider_id = $1
`;

const GET_USER_CACHE_SQL = `
  SELECT
    user_id,
    provider_id,
    credential_id,
    models_json,
    source_version,
    fetched_at,
    expires_at
  FROM provider_user_model_cache
  WHERE user_id = $1
    AND provider_id = $2
    AND credential_id = $3
  LIMIT 1
`;

const UPSERT_USER_CACHE_SQL = `
  INSERT INTO provider_user_model_cache (
    user_id,
    provider_id,
    credential_id,
    models_json,
    source_version,
    fetched_at,
    expires_at
  )
  VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
  ON CONFLICT (user_id, provider_id, credential_id)
  DO UPDATE SET
    models_json = EXCLUDED.models_json,
    source_version = EXCLUDED.source_version,
    fetched_at = EXCLUDED.fetched_at,
    expires_at = EXCLUDED.expires_at
`;

const DELETE_USER_CACHE_SQL = `
  DELETE FROM provider_user_model_cache
  WHERE user_id = $1
    AND provider_id = $2
    AND credential_id = $3
`;
