import { describe, expect, it } from "vitest";
import type { ProviderId } from "@repo/shared-types";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresCredentialStore } from "./PostgresCredentialStore.js";
import { CredentialEncryptionService } from "./credential-encryption.js";
import { PostgresPreferenceStore } from "./PostgresPreferenceStore.js";
import { PostgresProviderAuditLog } from "./PostgresProviderAuditLog.js";
import { PostgresProviderModelCacheStore } from "./PostgresProviderModelCacheStore.js";
import { PostgresProviderQuotaStore } from "./PostgresProviderQuotaStore.js";

class ScriptedSqlClient implements SqlClient {
  public readonly queries: Array<{
    statement: string;
    params: readonly SqlValue[];
  }> = [];

  constructor(
    private readonly handlers: Array<{
      pattern: string;
      response: (
        statement: string,
        params: readonly SqlValue[],
      ) => SqlQueryResult;
    }>,
  ) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    const rowParams = params ?? [];
    this.queries.push({ statement, params: rowParams });
    const handler = this.handlers.find((entry) =>
      statement.includes(entry.pattern),
    );
    if (!handler) {
      throw new Error(
        `[ScriptedSqlClient/query] No handler matched statement: ${statement}`,
      );
    }
    return handler.response(statement, rowParams) as SqlQueryResult<Row>;
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

describe("Postgres provider stores", () => {
  it("stores and decrypts credentials without exposing D1", async () => {
    const encryption = new CredentialEncryptionService();
    const apiKey = "sk-test-provider-key-123456";
    const encrypted = await encryption.encrypt(apiKey, {
      masterKey: MASTER_KEY,
      keyVersion: "v1",
    });
    const client = new ScriptedSqlClient([
      {
        pattern: "INSERT INTO provider_credentials",
        response: () =>
          rows([
            credentialRow({
              encrypted_secret_json: encrypted,
              key_fingerprint: "sk-t...3456",
            }),
          ]),
      },
      {
        pattern: "FROM provider_credentials",
        response: () =>
          rows([
            credentialRow({
              encrypted_secret_json: encrypted,
              key_fingerprint: "sk-t...3456",
            }),
          ]),
      },
    ]);
    const store = new PostgresCredentialStore(
      client,
      "user-1",
      "workspace-1",
      MASTER_KEY,
      "v1",
    );

    const created = await store.setCredential({
      credentialId: "cred-1",
      userId: "user-1",
      providerId: "openai" as ProviderId,
      label: "default",
      apiKey,
    });
    const read = await store.getCredentialWithKey("openai" as ProviderId);

    expect(created.credentialId).toBe("cred-1");
    expect(created.workspaceId).toBe("workspace-1");
    expect(client.queries[0]?.params[6]).toContain('"alg":"AES-256-GCM"');
    expect(client.queries[0]?.params[5]).toMatch(/^sha256:/);
    expect(read?.apiKey).toBe(apiKey);
  });

  it("persists provider preferences and credential labels", async () => {
    const client = new ScriptedSqlClient([
      {
        pattern: "FROM provider_preferences",
        response: () => rows([]),
      },
      {
        pattern: "INSERT INTO provider_preferences",
        response: () =>
          rows([
            preferenceRow({
              default_provider_id: "openai",
              visible_model_ids_json: { openai: ["gpt-4o"] },
              credential_labels_json: { "cred-1": "Primary" },
            }),
          ]),
      },
    ]);
    const store = new PostgresPreferenceStore(client, "user-1", "workspace-1");

    const updated = await store.updatePreferences({
      defaultProviderId: "openai" as ProviderId,
      visibleModelIds: { openai: ["gpt-4o"] },
    });

    expect(updated.defaultProviderId).toBe("openai");
    expect(updated.visibleModelIds.openai).toEqual(["gpt-4o"]);

    await store.setCredentialLabel("cred-1", "Primary");
    const credentialLabelParams = client.queries.at(-1)?.params ?? [];
    expect(credentialLabelParams[5]).toContain('"cred-1":"Primary"');
  });

  it("reads and writes provider model caches", async () => {
    const fetchedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const client = new ScriptedSqlClient([
      {
        pattern: "INSERT INTO provider_registry_cache",
        response: () => rows([]),
      },
      {
        pattern: "FROM provider_registry_cache",
        response: () =>
          rows([
            {
              provider_id: "openai",
              display_name: "OpenAI",
              auth_modes_json: [],
              capabilities_json: {},
              models_json: [
                {
                  id: "gpt-4o",
                  name: "GPT-4o",
                  providerId: "openai",
                },
              ],
              source_version: "provider_api",
              fetched_at: fetchedAt,
              expires_at: expiresAt,
              refreshed_at: fetchedAt,
            },
          ]),
      },
      {
        pattern: "FROM provider_user_model_cache",
        response: () =>
          rows([
            {
              user_id: "user-1",
              provider_id: "openrouter",
              credential_id: "cred-1",
              models_json: [
                {
                  id: "gpt-4o-mini",
                  name: "GPT-4o mini",
                  providerId: "openrouter",
                },
              ],
              source_version: "provider_api",
              fetched_at: fetchedAt,
              expires_at: expiresAt,
            },
          ]),
      },
    ]);
    const store = new PostgresProviderModelCacheStore(client, "user-1");

    await store.setModelCache({
      providerId: "openai",
      models: [{ id: "gpt-4o", name: "GPT-4o", providerId: "openai" }],
      fetchedAt,
      expiresAt,
      source: "provider_api",
    });
    const cached = await store.getModelCache("openai");
    expect(cached?.models[0]?.id).toBe("gpt-4o");
    expect(cached?.source).toBe("cache");

    await store.setUserModelCache(
      { providerId: "openrouter", credentialId: "cred-1" },
      {
        providerId: "openrouter",
        models: [
          {
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            providerId: "openrouter",
          },
        ],
        fetchedAt,
        expiresAt,
        source: "provider_api",
      },
    );
    const userCached = await store.getUserModelCache({
      providerId: "openrouter",
      credentialId: "cred-1",
    });
    expect(userCached?.models[0]?.id).toBe("gpt-4o-mini");
    await expect(
      store.setUserModelCache(
        { providerId: "openrouter", credentialId: "cred-1" },
        {
          providerId: "openai",
          models: [],
          fetchedAt,
          expiresAt,
          source: "provider_api",
        },
      ),
    ).rejects.toThrow("providerId mismatch");
  });

  it("tracks quota and audit events by scoped postgres rows", async () => {
    const client = new ScriptedSqlClient([
      {
        pattern: "INSERT INTO provider_axis_quota",
        response: () => rows([{ usage_count: 4 }]),
      },
      {
        pattern: "SELECT usage_count",
        response: () => rows([{ usage_count: 3 }]),
      },
      {
        pattern: "INSERT INTO provider_audit_events",
        response: () => rows([]),
      },
    ]);
    const quota = new PostgresProviderQuotaStore(
      client,
      "user-1",
      "workspace-1",
    );
    const audit = new PostgresProviderAuditLog(client, "user-1", "workspace-1");

    expect(await quota.getAxisQuotaUsage("2026-05-14")).toBe(3);
    expect(await quota.incrementAndGetQuota("2026-05-14")).toBe(4);
    await expect(quota.setAxisQuotaUsage("2026-05-14", -1)).rejects.toThrow(
      "invalid usage_count",
    );
    await audit.appendAuditEvent({
      eventType: "connect",
      status: "success",
      providerId: "openai" as ProviderId,
      message: "connected",
    });

    const auditParams = client.queries.at(-1)?.params ?? [];
    expect(auditParams[4]).toBe("connect");
    expect(auditParams[5]).toBe("success");
    expect(auditParams[7]).toContain("connected");
  });
});

function credentialRow(
  overrides: Partial<Record<string, unknown>> = {},
): SqlRow {
  return {
    id: "cred-1",
    user_id: "user-1",
    workspace_id: "workspace-1",
    provider_id: "openai",
    label: "default",
    key_fingerprint: "sk-t...3456",
    encrypted_secret_json: {
      alg: "AES-256-GCM",
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      keyVersion: "v1",
    },
    key_version: "v1",
    status: "connected",
    last_validated_at: null,
    last_error_code: null,
    last_error_message: null,
    created_by: "user-1",
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function preferenceRow(
  overrides: Partial<Record<string, unknown>> = {},
): SqlRow {
  return {
    user_id: "user-1",
    workspace_id: "workspace-1",
    default_provider_id: null,
    default_credential_id: null,
    default_model_id: null,
    fallback_mode: "strict",
    fallback_json: null,
    visible_model_ids_json: {},
    credential_labels_json: {},
    updated_at: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function rows<Row extends SqlRow>(rows: Row[]): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

const MASTER_KEY = "01234567890123456789012345678901";
