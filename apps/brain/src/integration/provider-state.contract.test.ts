import type { CoreMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

// NOTE: This contract test intentionally lives in src/integration because the
// PR3 readiness gate executes the exact path:
// `pnpm --filter @shadowbox/brain test -- src/integration/provider-state.contract.test.ts`
// Keep this location aligned with the documented gate in:
// plans/codex-like-app/Top-version/16-AUDIT-CLOSURE-AND-BYOK-READINESS-LLD.md
import type { ProviderId } from "@repo/shared-types";
import type { Env } from "../types/ai";
import { ProviderController } from "../controllers/ProviderController";
import { AIService } from "../services/AIService";
import { ProviderConfigService } from "../services/providers/ProviderConfigService";
import { OpenAICompatibleAdapter } from "../services/providers/adapters/OpenAICompatibleAdapter";
import {
  getRuntimeProviderFromAdapter,
  mapProviderIdToRuntimeProvider,
  resolveModelSelection,
} from "../services/ai/ModelSelectionPolicy";
import { setCompatModeOverride } from "../config/runtime-compat";
import {
  createD1Stores,
  getEncryptionConfig,
} from "../services/providers/stores/D1StoreFactory";
import { D1AuditService } from "../services/providers/D1AuditService";
import { D1AxisQuotaService } from "../services/providers/D1AxisQuotaService";
import {
  createTestByokD1Database,
  type TestByokD1Handle,
} from "../test-utils/byokTestD1";
import { createIdentitySessionRecord } from "../test-utils/identityTestHelpers";
import { resetByokSchemaReadyCacheForTests } from "../services/byok/ByokSchemaService.js";

const RUN_ID_A = "123e4567-e89b-42d3-a456-426614174001";
const RUN_ID_B = "123e4567-e89b-42d3-a456-426614174002";
const TEST_USER_ID = "user-123";
const TEST_WORKSPACE_ID = "workspace-main";
const TEST_WORKSPACE_ID_B = "workspace-alt";
const TEST_SESSION_SECRET = "test-session-secret";

describe("Provider State Contract: Controller/Runtime Shared Ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setCompatModeOverride(false);
    resetByokSchemaReadyCacheForTests();
    ProviderConfigService.resetForTests();
  });

  it("connects once and resolves the same credential on a different runId through D1-backed stores", async () => {
    const { env } = createEnvWithRunNamespace();

    const connectResponse = await ProviderController.byokConnect(
      new Request("http://localhost/api/byok/providers/connect", {
        method: "POST",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_A,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        body: JSON.stringify({
          providerId: "openai",
          apiKey: "sk-test-provider-state-1234567890",
        }),
      }),
      env,
    );
    expect(connectResponse.status).toBe(200);

    const connectionsResponse = await ProviderController.byokConnections(
      new Request("http://localhost/api/byok/providers/connections", {
        method: "GET",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_B,
          workspaceId: TEST_WORKSPACE_ID,
          contentType: null,
        }),
      }),
      env,
    );
    const connectionsBody = await connectionsResponse.json();
    expect(connectionsResponse.status).toBe(200);
    expect(
      connectionsBody.connections.some(
        (provider: { providerId: string; status: string }) =>
          provider.providerId === "openai" && provider.status === "connected",
      ),
    ).toBe(true);

    const runtimeProviderConfig = createRuntimeProviderConfigService(
      env,
      TEST_WORKSPACE_ID,
    );
    expect(await runtimeProviderConfig.getApiKey("openai")).toBe(
      "sk-test-provider-state-1234567890",
    );

    const generateSpy = vi
      .spyOn(OpenAICompatibleAdapter.prototype, "generate")
      .mockResolvedValue({
        content: "integration-inference-ok",
        usage: {
          provider: "openai",
          model: "gpt-4o",
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
        },
      });

    const aiService = new AIService(env, runtimeProviderConfig);
    const messages: CoreMessage[] = [{ role: "user", content: "hello" }];
    const inferenceResult = await aiService.generateText({
      messages,
      providerId: "openai",
      model: "gpt-4o",
    });

    expect(inferenceResult.text).toBe("integration-inference-ok");
    expect(inferenceResult.usage.provider).toBe("openai");
    expect(inferenceResult.usage.model).toBe("gpt-4o");
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials user-global while workspace preferences remain scoped", async () => {
    const { env } = createEnvWithRunNamespace();

    await connectProvider(env, {
      runId: RUN_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      providerId: "openai",
      apiKey: "sk-test-openai-1234567890",
    });
    await connectProvider(env, {
      runId: RUN_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      providerId: "groq",
      apiKey: "gsk_test_provider_state_1234567890",
    });

    const workspaceAPreferences = await ProviderController.byokPreferences(
      new Request("http://localhost/api/byok/preferences", {
        method: "PATCH",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_A,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        body: JSON.stringify({
          defaultProviderId: "openai",
          defaultModelId: "gpt-4o",
        }),
      }),
      env,
    );
    expect(workspaceAPreferences.status).toBe(200);

    const workspaceBPreferences = await ProviderController.byokPreferences(
      new Request("http://localhost/api/byok/preferences", {
        method: "PATCH",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_B,
          workspaceId: TEST_WORKSPACE_ID_B,
        }),
        body: JSON.stringify({
          defaultProviderId: "groq",
          defaultModelId: "llama-3.3-70b-versatile",
        }),
      }),
      env,
    );
    expect(workspaceBPreferences.status).toBe(200);

    const workspaceBConnections = await ProviderController.byokConnections(
      new Request("http://localhost/api/byok/providers/connections", {
        method: "GET",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_B,
          workspaceId: TEST_WORKSPACE_ID_B,
          contentType: null,
        }),
      }),
      env,
    );
    const workspaceBConnectionsBody = await workspaceBConnections.json();
    expect(workspaceBConnections.status).toBe(200);
    expect(
      workspaceBConnectionsBody.connections.some(
        (provider: { providerId: string; status: string }) =>
          provider.providerId === "openai" && provider.status === "connected",
      ),
    ).toBe(true);

    const resolveWorkspaceA = await ProviderController.byokResolve(
      new Request("http://localhost/api/byok/resolve", {
        method: "POST",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_A,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        body: JSON.stringify({}),
      }),
      env,
    );
    const resolveWorkspaceABody = await resolveWorkspaceA.json();
    expect(resolveWorkspaceA.status).toBe(200);
    expect(resolveWorkspaceABody.providerId).toBe("openai");
    expect(resolveWorkspaceABody.modelId).toBe("gpt-4o");

    const resolveWorkspaceB = await ProviderController.byokResolve(
      new Request("http://localhost/api/byok/resolve", {
        method: "POST",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_B,
          workspaceId: TEST_WORKSPACE_ID_B,
        }),
        body: JSON.stringify({}),
      }),
      env,
    );
    const resolveWorkspaceBBody = await resolveWorkspaceB.json();
    expect(resolveWorkspaceB.status).toBe(200);
    expect(resolveWorkspaceBBody.providerId).toBe("groq");
    expect(resolveWorkspaceBBody.modelId).toBe("llama-3.3-70b-versatile");
  });

  it("stores workspace credential labels in D1 without relying on session KV writes", async () => {
    const { env, byokDb } = createEnvWithRunNamespace();

    const connectResponse = await ProviderController.byokConnectCredential(
      new Request("http://localhost/api/byok/credentials", {
        method: "POST",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_A,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        body: JSON.stringify({
          providerId: "openai",
          secret: "sk-test-label-1234567890",
          label: "Primary",
        }),
      }),
      env,
    );
    const connectBody = await connectResponse.json();
    expect(connectResponse.status).toBe(200);
    expect(connectBody.label).toBe("Primary");

    const credentialsResponse = await ProviderController.byokCredentials(
      new Request("http://localhost/api/byok/credentials", {
        method: "GET",
        headers: await createByokHeaders(env, {
          runId: RUN_ID_A,
          workspaceId: TEST_WORKSPACE_ID,
          contentType: null,
        }),
      }),
      env,
    );
    const credentialsBody = await credentialsResponse.json();
    expect(credentialsResponse.status).toBe(200);
    expect(
      credentialsBody.find(
        (credential: { providerId: string; label: string }) =>
          credential.providerId === "openai",
      )?.label,
    ).toBe("Primary");

    const preferenceRow = byokDb.inspect.getPreference(
      TEST_USER_ID,
      TEST_WORKSPACE_ID,
    );
    expect(preferenceRow?.credential_labels_json).toContain("Primary");
  });

  it("enforces strict-mode typed errors for invalid provider selections", () => {
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

    expectDomainError(
      () =>
        resolveModelSelection(
          "openai",
          undefined,
          "litellm",
          "llama-3.3-70b-versatile",
          mapProviderIdToRuntimeProvider,
          getRuntimeProviderFromAdapter,
        ),
      "INVALID_PROVIDER_SELECTION",
    );
  });
});

function createEnvWithRunNamespace(): {
  env: Env;
  byokDb: TestByokD1Handle;
} {
  const byokDb = createTestByokD1Database();
  const allowedWorkspaceIds = [TEST_WORKSPACE_ID, TEST_WORKSPACE_ID_B];

  const env = {
    RUN_ENGINE_RUNTIME: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request =
            input instanceof Request ? input : new Request(String(input), init);
          const runId = request.headers.get("X-Run-Id");
          const userId = request.headers.get("X-User-Id");
          const workspaceId = request.headers.get("X-Workspace-Id");
          if (!runId) {
            return json({ error: "Missing required X-Run-Id header" }, 400);
          }
          if (runId !== id) {
            return json({ error: `X-Run-Id mismatch: expected ${id}` }, 400);
          }
          if (userId !== TEST_USER_ID || !workspaceId) {
            return json(
              {
                error: "Invalid BYOK scope",
                code: "AUTH_FAILED",
              },
              403,
            );
          }
          if (!allowedWorkspaceIds.includes(workspaceId)) {
            return json(
              {
                error: "Invalid BYOK scope",
                code: "AUTH_FAILED",
              },
              403,
            );
          }

          const configService = createRuntimeProviderConfigService(
            env as Env,
            workspaceId,
          );
          const url = new URL(request.url);
          return handleProviderRuntimeRoute(request, url, configService);
        },
      }),
    } as Env["RUN_ENGINE_RUNTIME"],
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => {
        throw new Error("not used");
      },
      findSessionByHash: async () =>
        createProviderIdentitySessionRecord(allowedWorkspaceIds),
      findLatestGitHubSessionByUserId: async () =>
        createProviderIdentitySessionRecord(allowedWorkspaceIds),
      revokeSession: async () => undefined,
    },
    BYOK_DB: byokDb.database,
    SESSION_SECRET: TEST_SESSION_SECRET,
    SESSIONS: {
      get: async (key: string) =>
        key === `user_session:${TEST_USER_ID}`
          ? JSON.stringify({
              userId: TEST_USER_ID,
              workspaceIds: allowedWorkspaceIds,
              defaultWorkspaceId: TEST_WORKSPACE_ID,
            })
          : null,
    } as Env["SESSIONS"],
    LLM_PROVIDER: "litellm",
    DEFAULT_MODEL: "llama-3.3-70b-versatile",
    GROQ_API_KEY: "test-key",
    OPENAI_API_KEY: "sk-env-openai-key",
    AXIS_OPENROUTER_API_KEY: "sk-or-v1-axis-managed-key",
    BYOK_CREDENTIAL_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    GITHUB_TOKEN_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  } as Env;

  return { env, byokDb };
}

function createRuntimeProviderConfigService(
  env: Env,
  workspaceId: string,
): ProviderConfigService {
  const encryptionConfig = getEncryptionConfig(
    env as unknown as Record<string, unknown>,
  );
  const stores = createD1Stores(env.BYOK_DB, {
    userId: TEST_USER_ID,
    workspaceId,
    masterKey: encryptionConfig.masterKey,
    keyVersion: encryptionConfig.keyVersion,
    previousKeyVersion: encryptionConfig.previousKeyVersion,
  });

  return new ProviderConfigService({
    env,
    userId: TEST_USER_ID,
    workspaceId,
    credentialStore: stores.credentialStore,
    preferenceStore: stores.preferenceStore,
    modelCacheStore: stores.modelCacheStore,
    auditLog: new D1AuditService(env.BYOK_DB, TEST_USER_ID, workspaceId),
    quotaStore: new D1AxisQuotaService(env.BYOK_DB, TEST_USER_ID, workspaceId),
  });
}

async function handleProviderRuntimeRoute(
  request: Request,
  url: URL,
  configService: ProviderConfigService,
): Promise<Response> {
  if (url.pathname === "/providers/connect" && request.method === "POST") {
    const body = (await request.json()) as {
      providerId: ProviderId;
      apiKey: string;
    };
    return json(await configService.connect(body), 200);
  }

  if (url.pathname === "/providers/disconnect" && request.method === "POST") {
    const body = (await request.json()) as {
      providerId: ProviderId;
    };
    return json(await configService.disconnect(body), 200);
  }

  if (url.pathname === "/providers/catalog" && request.method === "GET") {
    return json(await configService.getCatalog(), 200);
  }

  if (url.pathname === "/providers/connections" && request.method === "GET") {
    return json(await configService.getConnections(), 200);
  }

  if (url.pathname === "/providers/preferences" && request.method === "GET") {
    return json(await configService.getPreferences(), 200);
  }

  if (url.pathname === "/providers/preferences" && request.method === "PATCH") {
    const body = (await request.json()) as {
      defaultProviderId?: ProviderId;
      defaultModelId?: string;
    };
    return json(await configService.updatePreferences(body), 200);
  }

  if (
    url.pathname === "/providers/preferences/credential-labels" &&
    request.method === "POST"
  ) {
    const body = (await request.json()) as {
      credentialId: string;
      label: string;
    };
    return json(
      await configService.setCredentialLabel(body.credentialId, body.label),
      200,
    );
  }

  if (
    url.pathname.startsWith("/providers/preferences/credential-labels/") &&
    request.method === "DELETE"
  ) {
    const credentialId = decodeURIComponent(
      url.pathname.split("/").pop() ?? "",
    );
    return json(await configService.deleteCredentialLabel(credentialId), 200);
  }

  if (url.pathname === "/providers/axis/quota" && request.method === "GET") {
    return json(await configService.getAxisQuotaStatus(), 200);
  }

  return new Response("Not Found", { status: 404 });
}

async function connectProvider(
  env: Env,
  input: {
    runId: string;
    workspaceId: string;
    providerId: ProviderId;
    apiKey: string;
  },
): Promise<void> {
  const response = await ProviderController.byokConnect(
    new Request("http://localhost/api/byok/providers/connect", {
      method: "POST",
      headers: await createByokHeaders(env, input),
      body: JSON.stringify({
        providerId: input.providerId,
        apiKey: input.apiKey,
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
}

async function createByokHeaders(
  env: Env,
  options: {
    runId: string;
    workspaceId: string;
    contentType?: string | null;
  },
): Promise<Record<string, string>> {
  const token = await createSessionToken(TEST_USER_ID, env.SESSION_SECRET);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Run-Id": options.runId,
    "X-Workspace-Id": options.workspaceId,
    Cookie: `shadowbox_session=${token}`,
  };

  if (options.contentType === null) {
    delete headers["Content-Type"];
  } else if (options.contentType !== undefined) {
    headers["Content-Type"] = options.contentType;
  }

  return headers;
}

function createProviderIdentitySessionRecord(allowedWorkspaceIds: string[]) {
  return createIdentitySessionRecord({
    userId: TEST_USER_ID,
    workspaceIds: allowedWorkspaceIds,
    defaultWorkspaceId: TEST_WORKSPACE_ID,
  });
}

async function createSessionToken(
  userId: string,
  secret: string,
): Promise<string> {
  const timestamp = Date.now().toString();
  const data = `${userId}:${timestamp}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(data),
  );
  const signature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer)),
  );
  return `${data}:${signature}`;
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function expectDomainError(action: () => unknown, expectedCode: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : undefined;
    expect(code).toBe(expectedCode);
    return;
  }

  throw new Error(`Expected domain error ${expectedCode}`);
}
