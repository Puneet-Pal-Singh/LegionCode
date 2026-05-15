import type { ProviderId } from "@repo/shared-types";
import type {
  SqlClient,
  SqlQueryResult,
  SqlRow,
  SqlValue,
  ProviderModelCacheStore,
  ProviderAuditLog,
  ProviderQuotaStore,
  ProviderModelCacheRecord,
  ProviderAuditEvent,
  UserScopedCacheKey,
} from "@repo/persistence";
import {
  PostgresCredentialStore,
  PostgresPreferenceStore,
} from "@repo/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderConfigService } from "../services/providers/ProviderConfigService";
import {
  getRuntimeProviderFromAdapter,
  mapProviderIdToRuntimeProvider,
  resolveModelSelection,
} from "../services/ai/ModelSelectionPolicy";
import { setCompatModeOverride } from "../config/runtime-compat";
import type { Env } from "../types/ai";

const TEST_USER_ID = "user-123";
const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";
const MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Provider State Contract: Postgres-backed provider ownership", () => {
  afterEach(() => {
    setCompatModeOverride(false);
    ProviderConfigService.resetForTests();
  });

  it("shares credentials across runs while keeping workspace preferences isolated", async () => {
    const client = new MemoryProviderSqlClient();
    const serviceA = createProviderConfigService(client, WORKSPACE_A);
    const serviceB = createProviderConfigService(client, WORKSPACE_B);

    const connectResponse = await serviceA.connect({
      providerId: "openai" as ProviderId,
      apiKey: "sk-test-provider-state-1234567890",
    });
    expect(connectResponse.status).toBe("connected");
    expect(await serviceB.getApiKey("openai" as ProviderId)).toBe(
      "sk-test-provider-state-1234567890",
    );
    expect(await serviceB.isConnected("openai" as ProviderId)).toBe(true);

    await serviceA.updatePreferences({
      defaultProviderId: "openai" as ProviderId,
      defaultModelId: "gpt-4o",
    });
    await serviceB.updatePreferences({
      defaultProviderId: "groq" as ProviderId,
      defaultModelId: "llama-3.3-70b-versatile",
    });
    await serviceA.setCredentialLabel("credential-openai", "Primary");

    const preferencesA = await serviceA.getPreferences();
    const preferencesB = await serviceB.getPreferences();

    expect(preferencesA.defaultProviderId).toBe("openai");
    expect(preferencesA.defaultModelId).toBe("gpt-4o");
    expect(preferencesA.credentialLabels["credential-openai"]).toBe("Primary");
    expect(preferencesB.defaultProviderId).toBe("groq");
    expect(preferencesB.defaultModelId).toBe("llama-3.3-70b-versatile");
    expect(preferencesB.credentialLabels["credential-openai"]).toBeUndefined();
  });

  it("surfaces connected providers from the Postgres-backed vault", async () => {
    const client = new MemoryProviderSqlClient();
    const service = createProviderConfigService(client, WORKSPACE_A);

    await service.connect({
      providerId: "openai" as ProviderId,
      apiKey: "sk-test-provider-state-1234567890",
    });

    const connections = await service.getConnections();
    expect(
      connections.connections.some(
        (connection) =>
          connection.providerId === "openai" &&
          connection.status === "connected",
      ),
    ).toBe(true);
  });

  it("enforces strict provider selection rules", () => {
    setCompatModeOverride(false);

    const selection = resolveModelSelection(
      "openai",
      "llama-3.3-70b-versatile",
      "litellm",
      "llama-3.3-70b-versatile",
      mapProviderIdToRuntimeProvider,
      getRuntimeProviderFromAdapter,
    );

    expect(selection.provider).toBe("openai");
    expect(selection.model).toBe("llama-3.3-70b-versatile");
    expect(selection.fallback).toBe(false);

    expectDomainError(
      () =>
        resolveModelSelection(
          "invalid-provider",
          "gpt-4o",
          "litellm",
          "llama-3.3-70b-versatile",
          mapProviderIdToRuntimeProvider,
          getRuntimeProviderFromAdapter,
        ),
      "INVALID_PROVIDER_SELECTION",
    );
  });
});

function createProviderConfigService(
  client: SqlClient,
  workspaceId: string,
): ProviderConfigService {
  return new ProviderConfigService({
    env: createTestEnv(),
    userId: TEST_USER_ID,
    workspaceId,
    credentialStore: new PostgresCredentialStore(
      client,
      TEST_USER_ID,
      workspaceId,
      MASTER_KEY,
      "v1",
    ),
    preferenceStore: new PostgresPreferenceStore(
      client,
      TEST_USER_ID,
      workspaceId,
    ),
    modelCacheStore: new NoopProviderModelCacheStore(),
    auditLog: new NoopProviderAuditLog(),
    quotaStore: new NoopProviderQuotaStore(),
  });
}

function createTestEnv(): Env {
  return {
    AI: {} as Env["AI"],
    SECURE_API: {} as Env["SECURE_API"],
    BYOK_DB: {} as Env["BYOK_DB"],
    EDIT_ARTIFACTS: undefined,
    HYPERDRIVE: undefined,
    DATABASE_MIGRATIONS_MODE: "manual",
    AUTH_IDENTITY_REPOSITORY: undefined,
    AUTH_WORKSPACE_REPOSITORY: undefined,
    INTERNAL_RUNTIME_EVENT_SECRET: "test-secret",
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: undefined,
    AXIS_OPENROUTER_API_KEY: undefined,
    AXIS_DAILY_LIMIT: undefined,
    OPENAI_API_KEY: "sk-test-openai-key",
    SYSTEM_PROMPT: undefined,
    LLM_PROVIDER: "litellm",
    DEFAULT_MODEL: "gpt-4o",
    LITELLM_BASE_URL: undefined,
    COST_UNKNOWN_PRICING_MODE: undefined,
    COST_FAIL_ON_UNSEEDED_PRICING: undefined,
    MAX_RUN_BUDGET: undefined,
    MAX_SESSION_BUDGET: undefined,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    GITHUB_REDIRECT_URI: "http://localhost/oauth/callback",
    GITHUB_TOKEN_ENCRYPTION_KEY: MASTER_KEY,
    BYOK_CREDENTIAL_ENCRYPTION_KEY: MASTER_KEY,
    BYOK_CREDENTIAL_ENCRYPTION_KEY_VERSION: "v1",
    BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: undefined,
    BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION: undefined,
    BYOK_VALIDATE_LIVE_ENABLED: "false",
    BYOK_VALIDATE_LIVE_TIMEOUT_MS: undefined,
    BYOK_CONNECT_RATE_LIMIT_MAX: undefined,
    BYOK_CONNECT_RATE_LIMIT_WINDOW_SECONDS: undefined,
    BYOK_VALIDATE_RATE_LIMIT_MAX: undefined,
    BYOK_VALIDATE_RATE_LIMIT_WINDOW_SECONDS: undefined,
    SESSION_SECRET: "test-session-secret",
    FRONTEND_URL: "http://localhost:5173",
    CORS_ALLOWED_ORIGINS: undefined,
    CORS_ALLOW_DEV_ORIGINS: "true",
    FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1: undefined,
    FEATURE_FLAG_CHAT_REVIEWER_PASS_V1: undefined,
    FEATURE_FLAG_CLOUDFLARE_AGENTS_V1: undefined,
    FEATURE_FLAG_GH_CLI_LANE_ENABLED: undefined,
    FEATURE_FLAG_GH_CLI_CI_ENABLED: undefined,
    FEATURE_FLAG_GH_CLI_PR_COMMENT_ENABLED: undefined,
    LAUNCH_EMERGENCY_SHUTOFF_MODE: "off",
    RUN_SUBMISSION_RATE_LIMIT_MAX: undefined,
    RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS: undefined,
    MUTATION_RUN_SUBMISSION_RATE_LIMIT_MAX: undefined,
    MUTATION_RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS: undefined,
    ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX: undefined,
    ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX: undefined,
    ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX: undefined,
    ACTIVE_EXPENSIVE_RUNS_ANONYMOUS_MAX: undefined,
    ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS: undefined,
    MUSCLE_BASE_URL: undefined,
    SESSIONS: {} as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: {} as Env["RUN_ENGINE_RUNTIME"],
    RUN_ENGINE_AGENT: undefined,
    RUN_ADMISSION_LIMITER: undefined,
    SESSION_MEMORY_RUNTIME: undefined,
    NODE_ENV: "test",
    ENVIRONMENT: "development",
  };
}

class NoopProviderModelCacheStore implements ProviderModelCacheStore {
  async getModelCache(
    _providerId: string,
  ): Promise<ProviderModelCacheRecord | null> {
    return null;
  }

  async setModelCache(_record: ProviderModelCacheRecord): Promise<void> {}

  async invalidateModelCache(_providerId: string): Promise<void> {}

  async getUserModelCache(
    _key: UserScopedCacheKey,
  ): Promise<ProviderModelCacheRecord | null> {
    return null;
  }

  async setUserModelCache(
    _key: UserScopedCacheKey,
    _record: ProviderModelCacheRecord,
  ): Promise<void> {}

  async invalidateUserModelCache(_key: UserScopedCacheKey): Promise<void> {}
}

class NoopProviderAuditLog implements ProviderAuditLog {
  async appendAuditEvent(_event: ProviderAuditEvent): Promise<void> {}
}

class NoopProviderQuotaStore implements ProviderQuotaStore {
  async getAxisQuotaUsage(_dayKey: string): Promise<number> {
    return 0;
  }

  async setAxisQuotaUsage(_dayKey: string, _usage: number): Promise<void> {}

  async incrementAndGetQuota(_dayKey: string): Promise<number> {
    return 1;
  }
}

interface CredentialRow extends SqlRow {
  id: string;
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

interface PreferenceRow extends SqlRow {
  user_id: string;
  workspace_id: string;
  default_provider_id: string | null;
  default_credential_id: string | null;
  default_model_id: string | null;
  fallback_mode: string;
  fallback_json: unknown | null;
  visible_model_ids_json: unknown | null;
  credential_labels_json: unknown | null;
  updated_at: string;
}

class MemoryProviderSqlClient implements SqlClient {
  private readonly credentials = new Map<string, CredentialRow>();
  private readonly preferences = new Map<string, PreferenceRow>();

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    const values = [...(params ?? [])];

    if (statement.includes("INSERT INTO provider_credentials")) {
      const row = this.upsertCredential(values);
      return rows([row]) as SqlQueryResult<Row>;
    }

    if (statement.includes("SELECT DISTINCT provider_id")) {
      return rows(
        [...this.credentials.values()]
          .filter(
            (row) =>
              row.user_id === (values[0] as string) && row.deleted_at === null,
          )
          .map((row) => ({ provider_id: row.provider_id })),
      ) as SqlQueryResult<Row>;
    }

    if (statement.includes("FROM provider_credentials")) {
      const row = this.getCredential(
        values[0] as string,
        values[1] as ProviderId,
      );
      return rows(row ? [row] : []) as SqlQueryResult<Row>;
    }

    if (statement.includes("UPDATE provider_credentials")) {
      this.deleteCredential(
        values[1] as string,
        values[2] as ProviderId,
        values[0] as string,
      );
      return rows([]) as SqlQueryResult<Row>;
    }

    if (statement.includes("FROM provider_preferences")) {
      const row = this.preferences.get(
        this.preferenceKey(values[0], values[1]),
      );
      return rows(row ? [row] : []) as SqlQueryResult<Row>;
    }

    if (statement.includes("INSERT INTO provider_preferences")) {
      const row = statement.includes("jsonb_build_object")
        ? this.setCredentialLabel(values)
        : this.upsertPreference(values);
      return rows([row]) as SqlQueryResult<Row>;
    }

    if (statement.includes("UPDATE provider_preferences")) {
      this.deleteCredentialLabel(values);
      return rows([]) as SqlQueryResult<Row>;
    }

    throw new Error(`Unhandled SQL statement in test harness: ${statement}`);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }

  private upsertCredential(values: readonly SqlValue[]): CredentialRow {
    const row: CredentialRow = {
      id: String(values[0]),
      user_id: String(values[1]),
      workspace_id: String(values[2]),
      provider_id: String(values[3]),
      label: String(values[4]),
      key_fingerprint: String(values[5]),
      encrypted_secret_json: String(values[6]),
      key_version: String(values[7]),
      status: String(values[8]),
      created_by: values[9] === null ? null : String(values[9]),
      created_at: String(values[10]),
      updated_at: String(values[10]),
      last_validated_at: null,
      last_error_code: null,
      last_error_message: null,
      deleted_at: null,
    };
    this.credentials.set(this.credentialKey(row.user_id, row.provider_id), row);
    return row;
  }

  private getCredential(
    userId: string,
    providerId: ProviderId,
  ): CredentialRow | null {
    const row = this.credentials.get(this.credentialKey(userId, providerId));
    return row && row.deleted_at === null ? row : null;
  }

  private deleteCredential(
    userId: string,
    providerId: ProviderId,
    deletedAt: string,
  ): void {
    const row = this.credentials.get(this.credentialKey(userId, providerId));
    if (!row) {
      return;
    }
    row.deleted_at = deletedAt;
    row.updated_at = deletedAt;
  }

  private upsertPreference(values: readonly SqlValue[]): PreferenceRow {
    const key = this.preferenceKey(values[0], values[1]);
    const current = this.preferences.get(key);
    const row: PreferenceRow = {
      user_id: String(values[0]),
      workspace_id: String(values[1]),
      default_provider_id: values[6]
        ? valueToNullableString(values[2])
        : (current?.default_provider_id ?? null),
      default_credential_id: null,
      default_model_id: values[7]
        ? valueToNullableString(values[3])
        : (current?.default_model_id ?? null),
      fallback_mode: "strict",
      fallback_json: null,
      visible_model_ids_json: values[8]
        ? (values[4] ?? {})
        : (current?.visible_model_ids_json ?? {}),
      credential_labels_json: current?.credential_labels_json ?? {},
      updated_at: String(values[5]),
    };
    this.preferences.set(key, row);
    return row;
  }

  private setCredentialLabel(values: readonly SqlValue[]): PreferenceRow {
    const key = this.preferenceKey(values[0], values[1]);
    const current = this.preferences.get(key);
    const credentialLabels = {
      ...readRecord(current?.credential_labels_json),
      [String(values[2])]: String(values[3]),
    };
    const row: PreferenceRow = {
      user_id: String(values[0]),
      workspace_id: String(values[1]),
      default_provider_id: current?.default_provider_id ?? null,
      default_credential_id: null,
      default_model_id: current?.default_model_id ?? null,
      fallback_mode: "strict",
      fallback_json: null,
      visible_model_ids_json: current?.visible_model_ids_json ?? {},
      credential_labels_json: credentialLabels,
      updated_at: String(values[4]),
    };
    this.preferences.set(key, row);
    return row;
  }

  private deleteCredentialLabel(values: readonly SqlValue[]): void {
    const key = this.preferenceKey(values[0], values[1]);
    const current = this.preferences.get(key);
    if (!current) {
      return;
    }
    const credentialLabels = readRecord(current.credential_labels_json);
    delete credentialLabels[String(values[2])];
    current.credential_labels_json = credentialLabels;
    current.updated_at = String(values[3]);
  }

  private preferenceKey(userId: unknown, workspaceId: unknown): string {
    return `${String(userId)}:${String(workspaceId)}`;
  }

  private credentialKey(userId: string, providerId: ProviderId): string {
    return `${userId}:${providerId}`;
  }
}

function valueToNullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function readRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return record;
}

function rows<Row extends SqlRow>(rows: Row[]): SqlQueryResult<Row> {
  return {
    rows,
    rowCount: rows.length,
  };
}

function expectDomainError(run: () => unknown, expectedCode: string): void {
  try {
    run();
    throw new Error(`Expected error with code ${expectedCode}`);
  } catch (error) {
    expect(error).toMatchObject({ code: expectedCode });
  }
}
