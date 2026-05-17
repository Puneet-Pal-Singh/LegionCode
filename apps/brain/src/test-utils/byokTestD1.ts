import type { D1Database } from "@cloudflare/workers-types";

interface MigrationRow {
  migration_id: string;
  applied_at: string;
}

interface CredentialRow {
  credential_id: string;
  user_id: string;
  workspace_id: string;
  provider_id: string;
  label: string;
  key_fingerprint: string;
  encrypted_secret_json: string;
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

interface PreferenceRow {
  user_id: string;
  workspace_id: string;
  default_provider_id: string | null;
  default_credential_id: string | null;
  default_model_id: string | null;
  fallback_mode: string;
  fallback_json: string | null;
  visible_model_ids_json: string | null;
  credential_labels_json: string | null;
  updated_at: string;
}

interface AuditRow {
  event_id: string;
  user_id: string;
  workspace_id: string;
  provider_id: string | null;
  credential_id: string | null;
  operation: string;
  status: string;
  error_code: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface CacheRow {
  provider_id: string;
  display_name: string;
  auth_modes_json: string;
  capabilities_json: string;
  models_json: string;
  source_version: string;
  fetched_at: string;
  expires_at: string;
  refreshed_at: string;
}

interface UserCacheRow {
  provider_id: string;
  credential_id: string;
  models_json: string;
  source_version: string;
  fetched_at: string;
  expires_at: string;
}

interface QuotaRow {
  quota_key: string;
  value: number;
  updated_at: string;
}

interface TableInfoRow {
  cid: number;
  name: string;
}

interface RunResult {
  success: boolean;
}

interface TestByokD1State {
  migrations: Map<string, MigrationRow>;
  credentials: Map<string, CredentialRow>;
  preferences: Map<string, PreferenceRow>;
  auditEvents: AuditRow[];
  cache: Map<string, CacheRow>;
  userCache: Map<string, UserCacheRow>;
  quotas: Map<string, QuotaRow>;
  schema: Map<string, Set<string>>;
}

export interface TestByokD1Handle {
  database: D1Database;
  inspect: {
    getAppliedMigrationIds(): string[];
    getCredential(userId: string, providerId: string, label?: string): CredentialRow | undefined;
    getPreference(userId: string, workspaceId: string): PreferenceRow | undefined;
    hasTable(tableName: string): boolean;
    seedTable(tableName: string, columns: string[]): void;
    seedAppliedMigration(id: string, appliedAt?: string): void;
  };
}

export function createTestByokD1Database(): TestByokD1Handle {
  const state: TestByokD1State = {
    migrations: new Map(),
    credentials: new Map(),
    preferences: new Map(),
    auditEvents: [],
    cache: new Map(),
    userCache: new Map(),
    quotas: new Map(),
    schema: new Map(),
  };

  const database: D1Database = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return buildBoundStatement(state, sql, params);
        },
        all<T = unknown>() {
          return executeAll<T>(state, sql, []);
        },
        first<T = unknown>() {
          return executeFirst<T>(state, sql, []);
        },
        run() {
          return executeRun(state, sql, []);
        },
      };
    },
  } as D1Database;

  return {
    database,
    inspect: {
      getAppliedMigrationIds() {
        return Array.from(state.migrations.keys()).sort();
      },
      getCredential(userId: string, providerId: string, label: string = "default") {
        return state.credentials.get(buildCredentialKey(userId, providerId, label));
      },
      getPreference(userId: string, workspaceId: string) {
        return state.preferences.get(buildPreferenceKey(userId, workspaceId));
      },
      hasTable(tableName: string) {
        return state.schema.has(tableName);
      },
      seedTable(tableName: string, columns: string[]) {
        state.schema.set(tableName, new Set(columns));
      },
      seedAppliedMigration(id: string, appliedAt: string = new Date().toISOString()) {
        state.migrations.set(id, {
          migration_id: id,
          applied_at: appliedAt,
        });
      },
    },
  };
}

function buildBoundStatement(
  state: TestByokD1State,
  sql: string,
  params: unknown[],
) {
  return {
    all<T = unknown>() {
      return executeAll<T>(state, sql, params);
    },
    first<T = unknown>() {
      return executeFirst<T>(state, sql, params);
    },
    run() {
      return executeRun(state, sql, params);
    },
  };
}

async function executeAll<T>(
  state: TestByokD1State,
  sql: string,
  params: unknown[],
): Promise<{ results: T[] }> {
  return {
    results: performQuery(state, sql, params) as T[],
  };
}

async function executeFirst<T>(
  state: TestByokD1State,
  sql: string,
  params: unknown[],
): Promise<T | undefined> {
  const results = performQuery(state, sql, params);
  return results[0] as T | undefined;
}

async function executeRun(
  state: TestByokD1State,
  sql: string,
  params: unknown[],
): Promise<RunResult> {
  performMutation(state, sql, params);
  return { success: true };
}

function performQuery(
  state: TestByokD1State,
  sql: string,
  params: unknown[],
): unknown[] {
  const normalized = normalizeSql(sql);

  if (normalized === "SELECT migration_id FROM byok_schema_migrations") {
    assertTableExists(state, "byok_schema_migrations");
    return Array.from(state.migrations.values());
  }

  const pragmaMatch = normalized.match(/^PRAGMA table_info\(([^)]+)\)$/);
  if (pragmaMatch) {
    const tableName = pragmaMatch[1]!;
    const columns = state.schema.get(tableName);
    if (!columns) {
      return [];
    }
    return Array.from(columns.values()).map(
      (name, cid): TableInfoRow => ({ cid, name }),
    );
  }

  if (
    normalized ===
    "SELECT * FROM byok_credentials WHERE credential_id = ? AND deleted_at IS NULL LIMIT 1"
  ) {
    assertTableExists(state, "byok_credentials");
    const credentialId = String(params[0]);
    const row = Array.from(state.credentials.values()).find(
      (credential) =>
        credential.credential_id === credentialId && credential.deleted_at === null,
    );
    return row ? [row] : [];
  }

  if (
    normalized ===
    "SELECT * FROM byok_credentials WHERE user_id = ? AND provider_id = ? AND deleted_at IS NULL LIMIT 1"
  ) {
    assertTableExists(state, "byok_credentials");
    const userId = String(params[0]);
    const providerId = String(params[1]);
    const row = Array.from(state.credentials.values()).find(
      (credential) =>
        credential.user_id === userId &&
        credential.provider_id === providerId &&
        credential.deleted_at === null,
    );
    return row ? [row] : [];
  }

  if (
    normalized ===
    "SELECT * FROM byok_credentials WHERE user_id = ? AND provider_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1"
  ) {
    assertTableExists(state, "byok_credentials");
    const userId = String(params[0]);
    const providerId = String(params[1]);
    const row = Array.from(state.credentials.values())
      .filter(
        (credential) =>
          credential.user_id === userId &&
          credential.provider_id === providerId &&
          credential.deleted_at === null,
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return row ? [row] : [];
  }

  if (
    normalized.includes("FROM byok_credentials") &&
    normalized.includes("WHERE user_id = ? AND deleted_at IS NULL") &&
    normalized.includes("ORDER BY created_at DESC")
  ) {
    assertTableExists(state, "byok_credentials");
    const userId = String(params[0]);
    return Array.from(state.credentials.values())
      .filter(
        (credential) =>
          credential.user_id === userId && credential.deleted_at === null,
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  if (
    normalized ===
    "SELECT DISTINCT provider_id FROM byok_credentials WHERE user_id = ? AND deleted_at IS NULL ORDER BY provider_id"
  ) {
    assertTableExists(state, "byok_credentials");
    const userId = String(params[0]);
    return Array.from(
      new Set(
        Array.from(state.credentials.values())
          .filter(
            (credential) =>
              credential.user_id === userId && credential.deleted_at === null,
          )
          .map((credential) => credential.provider_id),
      ),
    )
      .sort()
      .map((provider_id) => ({ provider_id }));
  }

  if (
    normalized ===
    "SELECT * FROM byok_preferences WHERE user_id = ? AND workspace_id = ?"
  ) {
    assertTableExists(state, "byok_preferences");
    const userId = String(params[0]);
    const workspaceId = String(params[1]);
    const row = state.preferences.get(buildPreferenceKey(userId, workspaceId));
    return row ? [row] : [];
  }

  if (
    normalized ===
    "SELECT provider_id, models_json, fetched_at, expires_at, source_version FROM provider_registry_cache WHERE provider_id = ?"
  ) {
    assertTableExists(state, "provider_registry_cache");
    const providerId = String(params[0]);
    const row = state.cache.get(providerId);
    return row ? [row] : [];
  }

  if (
    normalized ===
    "SELECT provider_id, credential_id, models_json, fetched_at, expires_at, source_version FROM provider_user_model_cache WHERE provider_id = ? AND credential_id = ?"
  ) {
    return handleProviderUserModelCacheSelect(state, params);
  }

  if (
    normalized ===
    "SELECT value FROM provider_axis_quota WHERE quota_key = ?"
  ) {
    assertTableExists(state, "provider_axis_quota");
    const quotaKey = String(params[0]);
    const row = state.quotas.get(quotaKey);
    return row ? [{ value: row.value }] : [];
  }

  if (
    normalized ===
    "INSERT INTO provider_axis_quota (quota_key, value, updated_at) VALUES (?, 1, ?) ON CONFLICT(quota_key) DO UPDATE SET value = provider_axis_quota.value + 1, updated_at = excluded.updated_at RETURNING value"
  ) {
    assertTableExists(state, "provider_axis_quota");
    const quotaKey = String(params[0]);
    const updatedAt = String(params[1]);
    const existing = state.quotas.get(quotaKey);
    const nextValue = (existing?.value ?? 0) + 1;
    state.quotas.set(quotaKey, {
      quota_key: quotaKey,
      value: nextValue,
      updated_at: updatedAt,
    });
    return [{ value: nextValue }];
  }

  throw new Error(`Unsupported D1 query in test database: ${normalized}`);
}

function performMutation(
  state: TestByokD1State,
  sql: string,
  params: unknown[],
): void {
  const normalized = normalizeSql(sql);
  if (normalized.length === 0) {
    return;
  }

  if (normalized.startsWith("CREATE TABLE IF NOT EXISTS ")) {
    createTable(state, normalized);
    return;
  }

  if (
    normalized.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS ") ||
    normalized.startsWith("CREATE INDEX IF NOT EXISTS ") ||
    normalized.startsWith("DROP INDEX IF EXISTS ")
  ) {
    return;
  }

  if (normalized.startsWith("ALTER TABLE ")) {
    applyAlterTable(state, normalized);
    return;
  }

  if (
    normalized ===
    "INSERT INTO byok_schema_migrations (migration_id, applied_at) VALUES (?, ?)"
  ) {
    assertTableExists(state, "byok_schema_migrations");
    state.migrations.set(String(params[0]), {
      migration_id: String(params[0]),
      applied_at: String(params[1]),
    });
    return;
  }

  if (normalized.startsWith("INSERT INTO byok_credentials (")) {
    assertTableExists(state, "byok_credentials");
    const mappedParams = params.map((param) => toNullableString(param));
    const [
      credentialIdValue = null,
      userIdValue = null,
      workspaceIdValue = null,
      providerIdValue = null,
      labelValue = null,
      keyFingerprintValue = null,
      encryptedSecretJsonValue = null,
      keyVersionValue = null,
      statusValue = null,
      createdBy = null,
      createdAtValue = null,
      updatedAtValue = null,
    ] = mappedParams;
    const credentialId = credentialIdValue ?? "";
    const userId = userIdValue ?? "";
    const workspaceId = workspaceIdValue ?? "";
    const providerId = providerIdValue ?? "";
    const label = labelValue ?? "";
    const keyFingerprint = keyFingerprintValue ?? "";
    const encryptedSecretJson = encryptedSecretJsonValue ?? "";
    const keyVersion = keyVersionValue ?? "";
    const status = statusValue ?? "";
    const createdAt = createdAtValue ?? "";
    const updatedAt = updatedAtValue ?? "";
    const credentialKey = buildCredentialKey(userId, providerId, label);
    const existing = state.credentials.get(credentialKey);
    if (existing) {
      state.credentials.set(credentialKey, {
        ...existing,
        encrypted_secret_json: encryptedSecretJson,
        key_version: keyVersion,
        key_fingerprint: keyFingerprint,
        status: "connected",
        last_validated_at: null,
        last_error_code: null,
        last_error_message: null,
        updated_at: updatedAt,
        deleted_at: null,
      });
      return;
    }

    state.credentials.set(credentialKey, {
      credential_id: credentialId,
      user_id: userId,
      workspace_id: workspaceId,
      provider_id: providerId,
      label,
      key_fingerprint: keyFingerprint,
      encrypted_secret_json: encryptedSecretJson,
      key_version: keyVersion,
      status,
      last_validated_at: null,
      last_error_code: null,
      last_error_message: null,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: updatedAt,
      deleted_at: null,
    });
    return;
  }

  if (
    normalized ===
    "UPDATE byok_credentials SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND provider_id = ? AND deleted_at IS NULL"
  ) {
    assertTableExists(state, "byok_credentials");
    const [deletedAt = "", updatedAt = "", userId = "", providerId = ""] =
      params.map(String);
    for (const credential of state.credentials.values()) {
      if (
        credential.user_id === userId &&
        credential.provider_id === providerId &&
        credential.deleted_at === null
      ) {
        credential.deleted_at = deletedAt;
        credential.updated_at = updatedAt;
      }
    }
    return;
  }

  if (
    normalized ===
    "UPDATE byok_credentials SET deleted_at = ?, updated_at = ? WHERE credential_id = ? AND deleted_at IS NULL"
  ) {
    assertTableExists(state, "byok_credentials");
    const [deletedAt = "", updatedAt = "", credentialId = ""] =
      params.map(String);
    const credential = Array.from(state.credentials.values()).find(
      (entry) => entry.credential_id === credentialId && entry.deleted_at === null,
    );
    if (credential) {
      credential.deleted_at = deletedAt;
      credential.updated_at = updatedAt;
    }
    return;
  }

  if (
    normalized.startsWith("UPDATE byok_credentials SET") &&
    normalized.includes("WHERE user_id = ? AND provider_id = ? AND deleted_at IS NULL")
  ) {
    assertTableExists(state, "byok_credentials");
    updateCredentialMetadataByProvider(state, normalized, params);
    return;
  }

  if (
    normalized.startsWith("UPDATE byok_credentials SET") &&
    normalized.includes("WHERE credential_id = ? AND deleted_at IS NULL")
  ) {
    assertTableExists(state, "byok_credentials");
    updateCredentialMetadataById(state, normalized, params);
    return;
  }

  if (normalized.startsWith("INSERT INTO byok_preferences (")) {
    assertTableExists(state, "byok_preferences");
    upsertPreference(state, normalized, params);
    return;
  }

  if (normalized.startsWith("INSERT INTO byok_audit_events (")) {
    assertTableExists(state, "byok_audit_events");
    const [
      eventId,
      userId,
      workspaceId,
      providerId,
      credentialId,
      operation,
      status,
      errorCode,
      metadataJson,
      createdAt,
    ] = params;
    state.auditEvents.push({
      event_id: String(eventId),
      user_id: String(userId),
      workspace_id: String(workspaceId),
      provider_id: toNullableString(providerId),
      credential_id: toNullableString(credentialId),
      operation: String(operation),
      status: String(status),
      error_code: toNullableString(errorCode),
      metadata_json: toNullableString(metadataJson),
      created_at: String(createdAt),
    });
    return;
  }

  if (normalized.startsWith("INSERT INTO provider_registry_cache (")) {
    assertTableExists(state, "provider_registry_cache");
    const mappedParams = params.map(String);
    const [
      providerId = "",
      displayName = "",
      authModesJson = "",
      capabilitiesJson = "",
      modelsJson = "",
      sourceVersion = "",
      fetchedAt = "",
      expiresAt = "",
      refreshedAt = "",
    ] = mappedParams;
    state.cache.set(providerId, {
      provider_id: providerId,
      display_name: displayName,
      auth_modes_json: authModesJson,
      capabilities_json: capabilitiesJson,
      models_json: modelsJson,
      source_version: sourceVersion,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
      refreshed_at: refreshedAt,
    });
    return;
  }

  if (normalized.startsWith("INSERT INTO provider_user_model_cache (")) {
    handleProviderUserModelCacheInsert(state, params);
    return;
  }

  if (
    normalized ===
    "DELETE FROM provider_registry_cache WHERE provider_id = ?"
  ) {
    assertTableExists(state, "provider_registry_cache");
    state.cache.delete(String(params[0]));
    return;
  }

  if (
    normalized ===
    "DELETE FROM provider_user_model_cache WHERE provider_id = ? AND credential_id = ?"
  ) {
    handleProviderUserModelCacheDelete(state, params);
    return;
  }

  if (
    normalized ===
    "INSERT INTO provider_axis_quota (quota_key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(quota_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ) {
    assertTableExists(state, "provider_axis_quota");
    const [quotaKey, value, updatedAt] = params;
    state.quotas.set(String(quotaKey), {
      quota_key: String(quotaKey),
      value: Number(value),
      updated_at: String(updatedAt),
    });
    return;
  }

  if (
    normalized ===
    "INSERT INTO provider_axis_quota (quota_key, value, updated_at) VALUES (?, 1, ?) ON CONFLICT(quota_key) DO UPDATE SET value = provider_axis_quota.value + 1, updated_at = excluded.updated_at RETURNING value"
  ) {
    assertTableExists(state, "provider_axis_quota");
    const quotaKey = String(params[0]);
    const updatedAt = String(params[1]);
    const existing = state.quotas.get(quotaKey);
    state.quotas.set(quotaKey, {
      quota_key: quotaKey,
      value: (existing?.value ?? 0) + 1,
      updated_at: updatedAt,
    });
    return;
  }

  throw new Error(`Unsupported D1 mutation in test database: ${normalized}`);
}

function createTable(state: TestByokD1State, normalized: string): void {
  const tables: Record<string, string[]> = {
    byok_schema_migrations: ["migration_id", "applied_at"],
    byok_credentials: [
      "credential_id",
      "user_id",
      "workspace_id",
      "provider_id",
      "label",
      "key_fingerprint",
      "encrypted_secret_json",
      "key_version",
      "status",
      "last_validated_at",
      "last_error_code",
      "last_error_message",
      "created_by",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    byok_preferences: [
      "user_id",
      "workspace_id",
      "default_provider_id",
      "default_credential_id",
      "default_model_id",
      "fallback_mode",
      "fallback_json",
      "updated_at",
    ],
    byok_audit_events: [
      "event_id",
      "user_id",
      "workspace_id",
      "provider_id",
      "credential_id",
      "operation",
      "status",
      "error_code",
      "metadata_json",
      "created_at",
    ],
    provider_axis_quota: ["quota_key", "value", "updated_at"],
    provider_registry_cache: [
      "provider_id",
      "display_name",
      "auth_modes_json",
      "capabilities_json",
      "models_json",
      "source_version",
      "fetched_at",
      "expires_at",
      "refreshed_at",
    ],
    provider_user_model_cache: [
      "provider_id",
      "credential_id",
      "models_json",
      "source_version",
      "fetched_at",
      "expires_at",
    ],
  };

  const tableName = normalized
    .replace("CREATE TABLE IF NOT EXISTS ", "")
    .split(" ", 1)[0] ?? "";
  if (!tableName || !(tableName in tables)) {
    throw new Error(`Unsupported test D1 table creation: ${normalized}`);
  }

  const existingColumns = state.schema.get(tableName) ?? new Set<string>();
  for (const column of tables[tableName]!) {
    existingColumns.add(column);
  }
  state.schema.set(tableName, existingColumns);
}

function handleProviderUserModelCacheSelect(
  state: TestByokD1State,
  params: unknown[],
): unknown[] {
  assertTableExists(state, "provider_user_model_cache");
  const providerId = String(params[0]);
  const credentialId = String(params[1]);
  const row = state.userCache.get(buildUserCacheKey(providerId, credentialId));
  return row ? [row] : [];
}

function handleProviderUserModelCacheInsert(
  state: TestByokD1State,
  params: unknown[],
): void {
  assertTableExists(state, "provider_user_model_cache");
  const mappedParams = params.map(String);
  const [
    providerId = "",
    credentialId = "",
    modelsJson = "",
    sourceVersion = "",
    fetchedAt = "",
    expiresAt = "",
  ] = mappedParams;
  state.userCache.set(buildUserCacheKey(providerId, credentialId), {
    provider_id: providerId,
    credential_id: credentialId,
    models_json: modelsJson,
    source_version: sourceVersion,
    fetched_at: fetchedAt,
    expires_at: expiresAt,
  });
}

function handleProviderUserModelCacheDelete(
  state: TestByokD1State,
  params: unknown[],
): void {
  assertTableExists(state, "provider_user_model_cache");
  state.userCache.delete(buildUserCacheKey(String(params[0]), String(params[1])));
}

function applyAlterTable(state: TestByokD1State, normalized: string): void {
  const match = normalized.match(
    /^ALTER TABLE ([a-zA-Z0-9_]+) ADD COLUMN ([a-zA-Z0-9_]+)/,
  );
  if (!match) {
    throw new Error(`Unsupported ALTER TABLE in test database: ${normalized}`);
  }

  const tableName = match[1] ?? "";
  const columnName = match[2] ?? "";
  assertTableExists(state, tableName);
  const columns = state.schema.get(tableName)!;
  columns.add(columnName);
}

function upsertPreference(
  state: TestByokD1State,
  normalized: string,
  params: unknown[],
): void {
  const [
    userId,
    workspaceId,
    defaultProviderId,
    defaultModelId,
    fallbackMode,
    fallbackJson,
    visibleModelIdsJson,
    credentialLabelsJson,
    updatedAt,
  ] = params;
  const key = buildPreferenceKey(String(userId), String(workspaceId));
  const current = state.preferences.get(key);

  if (!current) {
    state.preferences.set(key, {
      user_id: String(userId),
      workspace_id: String(workspaceId),
      default_provider_id: toNullableString(defaultProviderId),
      default_credential_id: null,
      default_model_id: toNullableString(defaultModelId),
      fallback_mode: String(fallbackMode),
      fallback_json: toNullableString(fallbackJson),
      visible_model_ids_json: toNullableString(visibleModelIdsJson),
      credential_labels_json: toNullableString(credentialLabelsJson),
      updated_at: String(updatedAt),
    });
    return;
  }

  if (
    normalized.includes(
      "default_provider_id = COALESCE(excluded.default_provider_id, byok_preferences.default_provider_id)",
    )
  ) {
    current.default_provider_id =
      toNullableString(defaultProviderId) ?? current.default_provider_id;
    current.default_model_id =
      toNullableString(defaultModelId) ?? current.default_model_id;
    current.visible_model_ids_json = toNullableString(visibleModelIdsJson);
  }

  current.credential_labels_json = toNullableString(credentialLabelsJson);
  current.updated_at = String(updatedAt);
}

function updateCredentialMetadataByProvider(
  state: TestByokD1State,
  normalized: string,
  params: unknown[],
): void {
  const clauses = extractSetClauses(normalized);
  const userId = String(params[params.length - 2]);
  const providerId = String(params[params.length - 1]);
  const values = params.slice(0, -2);

  for (const credential of state.credentials.values()) {
    if (
      credential.user_id === userId &&
      credential.provider_id === providerId &&
      credential.deleted_at === null
    ) {
      applyCredentialSetClauses(credential, clauses, values);
    }
  }
}

function buildUserCacheKey(providerId: string, credentialId: string): string {
  return `${providerId}:${credentialId}`;
}

function updateCredentialMetadataById(
  state: TestByokD1State,
  normalized: string,
  params: unknown[],
): void {
  const clauses = extractSetClauses(normalized);
  const credentialId = String(params[params.length - 1]);
  const values = params.slice(0, -1);
  const credential = Array.from(state.credentials.values()).find(
    (entry) => entry.credential_id === credentialId && entry.deleted_at === null,
  );
  if (credential) {
    applyCredentialSetClauses(credential, clauses, values);
  }
}

function applyCredentialSetClauses(
  credential: CredentialRow,
  clauses: string[],
  values: unknown[],
): void {
  clauses.forEach((clause, index) => {
    const value = values[index];
    if (clause.startsWith("updated_at")) {
      credential.updated_at = String(value);
      return;
    }
    if (clause.startsWith("status")) {
      credential.status = String(value);
      return;
    }
    if (clause.startsWith("last_validated_at")) {
      credential.last_validated_at = toNullableString(value);
      return;
    }
    if (clause.startsWith("last_error_code")) {
      credential.last_error_code = toNullableString(value);
      return;
    }
    if (clause.startsWith("last_error_message")) {
      credential.last_error_message = toNullableString(value);
    }
  });
}

function extractSetClauses(normalized: string): string[] {
  const setSegment = normalized.split(" SET ")[1]?.split(" WHERE ")[0];
  if (!setSegment) {
    return [];
  }
  return setSegment.split(", ").map((clause) => clause.trim());
}

function assertTableExists(state: TestByokD1State, tableName: string): void {
  if (!state.schema.has(tableName)) {
    throw new Error(`no such table: ${tableName}`);
  }
}

function buildCredentialKey(
  userId: string,
  providerId: string,
  label: string,
): string {
  return `${userId}:${providerId}:${label}`;
}

function buildPreferenceKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function normalizeSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/g, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
