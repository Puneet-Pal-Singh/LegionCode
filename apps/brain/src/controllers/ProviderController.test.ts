import { AppServerController } from "./AppServerController";
import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { describe, it, expect } from "vitest";
import { ProviderController } from "./ProviderController";
import type { Env } from "../types/ai";
import type {
  BYOKModelPricing,
  ProviderConnectionConfig,
  ProviderId,
} from "@repo/shared-types";

const TEST_RUN_ID = "run_123e4567e89b42d3a456426614174000";
const TEST_USER_ID = "user-123";
const TEST_WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174111";
const TEST_SESSION_SECRET = "test-session-secret";
const TEST_SESSION_TOKEN = "test-session-token";

function createMockEnv(options?: {
  axisConnected?: boolean;
  mutationFailure?: { path: string; method: string; enabled: boolean };
  catalogError?: boolean;
  connectionsError?: boolean;
  failedConnectionProviders?: ProviderId[];
  emptyCatalogProviders?: ProviderId[];
  preferencesError?: boolean;
  sessionsGetError?: boolean;
  omitWorkspaceClaims?: boolean;
  environment?: "production" | "staging" | "development";
  connectRequests?: Array<{
    providerId: ProviderId;
    apiKey?: string;
    config?: ProviderConnectionConfig;
  }>;
}): Env {
  const axisConnected = options?.axisConnected ?? true;
  const environment = options?.environment ?? "development";
  const providerState = new Map<string, Set<ProviderId>>();
  const preferencesState = new Map<
    string,
    {
      defaultProviderId?: ProviderId;
      defaultModelId?: string;
      credentialLabels?: Record<string, string>;
      updatedAt: string;
    }
  >();
  const oauthState = new Map<string, string>();

  const catalog: Record<
    ProviderId,
    Array<{
      id: string;
      name: string;
      contextWindow?: number;
      pricing?: BYOKModelPricing;
    }>
  > = {
    axis: [
      { id: "z-ai/glm-4.5-air:free", name: "z-ai/glm-4.5-air:free" },
      {
        id: "nvidia/nemotron-3-nano-30b-a3b:free",
        name: "nvidia/nemotron-3-nano-30b-a3b:free",
      },
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        name: "nvidia/nemotron-3-super-120b-a12b:free",
      },
      {
        id: "arcee-ai/trinity-large-preview:free",
        name: "arcee-ai/trinity-large-preview:free",
      },
      {
        id: "stepfun/step-3.5-flash:free",
        name: "stepfun/step-3.5-flash:free",
      },
      {
        id: "qwen/qwen3.6-plus:free",
        name: "qwen/qwen3.6-plus:free",
      },
    ],
    openai: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        contextWindow: 128_000,
        pricing: {
          inputPer1M: 2.5,
          outputPer1M: 10,
          currency: "USD",
        },
      },
    ],
    openrouter: [{ id: "openrouter/auto", name: "Auto" }],
    groq: [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" }],
    "cloudflare-ai": [
      {
        id: "@cf/meta/llama-3.1-8b-instruct",
        name: "Llama 3.1 8B Instruct",
      },
    ],
  };
  for (const providerId of options?.emptyCatalogProviders ?? []) {
    catalog[providerId] = [];
  }
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(request.url);
        const runId = request.headers.get("X-Run-Id");
        const userId = request.headers.get("X-User-Id");
        const workspaceId = request.headers.get("X-Workspace-Id");

        if (!runId || runId !== id) {
          return jsonError("Missing required X-Run-Id header", 400);
        }

        if (userId !== TEST_USER_ID || workspaceId !== TEST_WORKSPACE_ID) {
          return jsonError("Invalid BYOK scope", 403, "AUTH_FAILED");
        }

        const mutationFailure = options?.mutationFailure;
        if (mutationFailure?.enabled && mutationFailure.path === url.pathname && mutationFailure.method === request.method) {
          return jsonError("Runtime credential mutation unavailable", 503, "PROVIDER_UNAVAILABLE");
        }

        const scopeKey = `${userId}:${workspaceId}`;
        if (!providerState.has(scopeKey)) {
          providerState.set(scopeKey, new Set<ProviderId>());
        }
        const connectedProviders = providerState.get(scopeKey)!;

        if (
          url.pathname === "/providers/connect" &&
          request.method === "POST"
        ) {
          const body = (await request.json()) as {
            providerId: ProviderId;
            apiKey?: string;
            config?: ProviderConnectionConfig;
          };
          if (body.providerId === "axis") {
            return jsonError(
              'Provider "axis" is platform-managed and cannot be manually connected or disconnected.',
              400,
              "INVALID_PROVIDER_SELECTION",
            );
          }
          options?.connectRequests?.push(body);
          connectedProviders.add(body.providerId);
          return jsonOk({
            status: "connected",
            providerId: body.providerId,
            lastValidatedAt: new Date().toISOString(),
          });
        }

        if (
          url.pathname === "/providers/disconnect" &&
          request.method === "POST"
        ) {
          const body = (await request.json()) as { providerId: ProviderId };
          if (body.providerId === "axis") {
            return jsonError(
              'Provider "axis" is platform-managed and cannot be manually connected or disconnected.',
              400,
              "INVALID_PROVIDER_SELECTION",
            );
          }
          connectedProviders.delete(body.providerId);
          return jsonOk({
            status: "disconnected",
            providerId: body.providerId,
          });
        }

        if (url.pathname === "/providers/catalog" && request.method === "GET") {
          if (options?.catalogError) {
            return jsonError(
              "Provider catalog unavailable",
              500,
              "PROVIDER_UNAVAILABLE",
            );
          }
          return jsonOk({
            providers: (
              [
                "axis",
                "openrouter",
                "openai",
                "groq",
                "cloudflare-ai",
              ] as ProviderId[]
            ).map((providerId) => ({
              providerId,
              displayName: providerId.toUpperCase(),
              capabilities: {
                streaming: true,
                tools: true,
                structuredOutputs: true,
                jsonMode: true,
              },
              models: catalog[providerId].map((model) => ({
                ...model,
                provider: providerId,
              })),
            })),
            generatedAt: new Date().toISOString(),
          });
        }

        if (url.pathname === "/providers/models" && request.method === "GET") {
          const providerId = url.searchParams.get(
            "providerId",
          ) as ProviderId | null;
          if (!providerId || !(providerId in catalog)) {
            return jsonError(
              "Missing or invalid providerId",
              400,
              "MISSING_PROVIDER_ID",
            );
          }
          const view = url.searchParams.get("view");
          if (view) {
            const models = catalog[providerId].map((model) => ({
              ...model,
              providerId,
            }));
            return jsonOk({
              providerId,
              view,
              models,
              page: {
                limit: Number(url.searchParams.get("limit") ?? "50"),
                nextCursor: url.searchParams.get("cursor") ?? undefined,
                hasMore: false,
              },
              metadata: {
                fetchedAt: new Date().toISOString(),
                stale: false,
                source: "provider_api",
              },
            });
          }
          return jsonOk({
            providerId,
            models: catalog[providerId].map((model) => ({
              ...model,
              provider: providerId,
            })),
            lastFetchedAt: new Date().toISOString(),
          });
        }

        if (
          url.pathname === "/providers/models/refresh" &&
          request.method === "POST"
        ) {
          const body = (await request.json()) as { providerId: ProviderId };
          return jsonOk({
            providerId: body.providerId,
            refreshedAt: new Date().toISOString(),
            source: "provider_api",
            cacheInvalidated: true,
            modelsCount: catalog[body.providerId]?.length ?? 0,
          });
        }

        if (
          url.pathname === "/providers/connections" &&
          request.method === "GET"
        ) {
          if (options?.connectionsError) {
            return jsonError(
              "Provider connections unavailable",
              500,
              "PROVIDER_UNAVAILABLE",
            );
          }
          return jsonOk({
            connections: (
              [
                "axis",
                "openrouter",
                "openai",
                "groq",
                "cloudflare-ai",
              ] as ProviderId[]
            ).map((providerId) => {
              const failedProviders = new Set(
                options?.failedConnectionProviders ?? [],
              );
              const status = failedProviders.has(providerId)
                ? "failed"
                : (providerId === "axis" && axisConnected) ||
                    connectedProviders.has(providerId)
                  ? "connected"
                  : "disconnected";

              return {
                providerId,
                status,
                errorCode:
                  status === "failed" ? "PROVIDER_UNAVAILABLE" : undefined,
                errorMessage:
                  status === "failed"
                    ? "Credential store is temporarily unavailable for this provider."
                    : undefined,
                capabilities: {
                  streaming: true,
                  tools: true,
                  structuredOutputs: true,
                  jsonMode: true,
                },
              };
            }),
          });
        }

        if (
          url.pathname === "/providers/axis/quota" &&
          request.method === "GET"
        ) {
          return jsonOk({
            used: 0,
            limit: 5,
            resetsAt: "2026-03-12T00:00:00.000Z",
          });
        }

        if (
          url.pathname === "/providers/validate" &&
          request.method === "POST"
        ) {
          const body = (await request.json()) as { providerId: ProviderId };
          if (!connectedProviders.has(body.providerId)) {
            return jsonError(
              `Provider "${body.providerId}" is not connected.`,
              400,
              "PROVIDER_NOT_CONNECTED",
            );
          }
          return jsonOk({
            providerId: body.providerId,
            status: "valid",
            checkedAt: new Date().toISOString(),
          });
        }

        if (
          url.pathname === "/providers/preferences" &&
          request.method === "GET"
        ) {
          if (options?.preferencesError) {
            return jsonError(
              "Provider preferences unavailable",
              500,
              "PROVIDER_UNAVAILABLE",
            );
          }
          const current = preferencesState.get(scopeKey) ?? {
            credentialLabels: {},
            updatedAt: new Date().toISOString(),
          };
          return jsonOk(current);
        }

        if (
          url.pathname === "/providers/preferences" &&
          request.method === "PATCH"
        ) {
          if (options?.preferencesError) {
            return jsonError(
              "Provider preferences unavailable",
              500,
              "PROVIDER_UNAVAILABLE",
            );
          }
          const body = (await request.json()) as {
            defaultProviderId?: ProviderId;
            defaultModelId?: string;
          };
          const current = preferencesState.get(scopeKey) ?? {
            credentialLabels: {},
            updatedAt: new Date().toISOString(),
          };
          const next = {
            defaultProviderId:
              body.defaultProviderId ?? current.defaultProviderId,
            defaultModelId: body.defaultModelId ?? current.defaultModelId,
            credentialLabels: current.credentialLabels ?? {},
            updatedAt: new Date().toISOString(),
          };
          preferencesState.set(scopeKey, next);
          return jsonOk(next);
        }

        if (
          url.pathname === "/providers/preferences/credential-labels" &&
          request.method === "POST"
        ) {
          const body = (await request.json()) as {
            credentialId: string;
            label: string;
          };
          const current = preferencesState.get(scopeKey) ?? {
            credentialLabels: {},
            updatedAt: new Date().toISOString(),
          };
          const next = {
            defaultProviderId: current.defaultProviderId,
            defaultModelId: current.defaultModelId,
            credentialLabels: {
              ...(current.credentialLabels ?? {}),
              [body.credentialId]: body.label,
            },
            updatedAt: new Date().toISOString(),
          };
          preferencesState.set(scopeKey, next);
          return jsonOk(next);
        }

        if (
          url.pathname.startsWith(
            "/providers/preferences/credential-labels/",
          ) &&
          request.method === "DELETE"
        ) {
          const credentialId = decodeURIComponent(
            url.pathname.split("/").pop() ?? "",
          );
          const current = preferencesState.get(scopeKey) ?? {
            credentialLabels: {},
            updatedAt: new Date().toISOString(),
          };
          const credentialLabels = { ...(current.credentialLabels ?? {}) };
          delete credentialLabels[credentialId];
          const next = {
            defaultProviderId: current.defaultProviderId,
            defaultModelId: current.defaultModelId,
            credentialLabels,
            updatedAt: new Date().toISOString(),
          };
          preferencesState.set(scopeKey, next);
          return jsonOk(next);
        }

        return new Response("Not Found", { status: 404 });
      },
    }),
  };

  return {
    RUN_ENGINE_RUNTIME: namespace as unknown as Env["RUN_ENGINE_RUNTIME"],
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => {
        throw new Error("not used");
      },
      findSessionByHash: async () => {
        if (options?.sessionsGetError) {
          throw new Error("database unavailable");
        }
        return createIdentitySessionRecord({
          omitWorkspaceClaims: options?.omitWorkspaceClaims,
        });
      },
      findLatestGitHubSessionByUserId: async () => {
        if (options?.sessionsGetError) {
          throw new Error("database unavailable");
        }
        return createIdentitySessionRecord({
          omitWorkspaceClaims: options?.omitWorkspaceClaims,
        });
      },
      revokeSession: async () => undefined,
    },
    SESSION_SECRET: TEST_SESSION_SECRET,
    SESSIONS: {
      get: async (key: string) => {
        return oauthState.get(key) ?? null;
      },
      put: async (key: string, value: string) => {
        oauthState.set(key, value);
      },
      delete: async (key: string) => {
        oauthState.delete(key);
      },
    } as unknown as Env["SESSIONS"],
    LLM_PROVIDER: "litellm",
    DEFAULT_MODEL: "llama-3.3-70b-versatile",
    GROQ_API_KEY: "test-key",
    NODE_ENV: environment === "production" ? "production" : "development",
    ENVIRONMENT: environment,
  } as unknown as Env;
}

async function withByokHeaders(
  env: Env,
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    "X-Run-Id": TEST_RUN_ID,
    Cookie: `legioncode_session=${TEST_SESSION_TOKEN}`,
    ...headers,
  };
}

function createIdentitySessionRecord(
  options: { omitWorkspaceClaims?: boolean } = {},
) {
  const record = {
    authSessionId: "session-1",
    userId: TEST_USER_ID,
    login: "puneet",
    avatar: "",
    email: "puneet@example.com",
    name: "Puneet Pal Singh",
    githubScopes: ["repo"],
    encryptedToken: {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
    },
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    workspaceId: TEST_WORKSPACE_ID,
    defaultWorkspaceId: TEST_WORKSPACE_ID,
    workspaceIds: [TEST_WORKSPACE_ID],
  };
  if (options.omitWorkspaceClaims) {
    return {
      ...record,
      workspaceId: undefined,
      defaultWorkspaceId: undefined,
      workspaceIds: undefined,
    };
  }
  return record;
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number, code?: string): Response {
  const body = code ? { error: message, code } : { error: message };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProviderController", () => {
  describe("byok v2", () => {
    it("connects provider with valid API key", async () => {
      const env = createMockEnv();
      const request = new Request(
        "http://localhost/api/byok/providers/connect",
        {
          method: "POST",
          body: JSON.stringify({
            providerId: "openai",
            apiKey: "sk-test-1234567890",
          }),
          headers: await withByokHeaders(env),
        },
      );

      const response = await ProviderController.byokConnect(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("connected");
      expect(data.providerId).toBe("openai");
    });

    it("fails connect without runId", async () => {
      const env = createMockEnv();
      const headers = await withByokHeaders(env);
      delete headers["X-Run-Id"];

      const request = new Request(
        "http://localhost/api/byok/providers/connect",
        {
          method: "POST",
          body: JSON.stringify({
            providerId: "openai",
            apiKey: "sk-test-1234567890",
          }),
          headers,
        },
      );

      const response = await ProviderController.byokConnect(request, env);
      expect(response.status).toBe(400);
    });

    it("rejects requests without valid auth claims", async () => {
      const env = createMockEnv();
      const request = new Request(
        "http://localhost/api/byok/providers/catalog",
        {
          method: "GET",
          headers: { "X-Run-Id": TEST_RUN_ID },
        },
      );

      const response = await ProviderController.byokCatalog(request, env);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("AUTH_FAILED");
    });

    it("rejects client-supplied user scope mismatch", async () => {
      const env = createMockEnv();
      const request = new Request(
        "http://localhost/api/byok/providers/catalog",
        {
          method: "GET",
          headers: await withByokHeaders(env, {
            "X-User-Id": "different-user",
          }),
        },
      );

      const response = await ProviderController.byokCatalog(request, env);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("AUTH_FAILED");
    });

    it("rejects unauthorized workspace scope", async () => {
      const env = createMockEnv();
      const request = new Request(
        "http://localhost/api/byok/providers/catalog",
        {
          method: "GET",
          headers: await withByokHeaders(env, {
            "X-Workspace-Id": "workspace-other",
          }),
        },
      );

      const response = await ProviderController.byokCatalog(request, env);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("AUTH_FAILED");
    });

    it("rejects provider requests without a persisted workspace claim", async () => {
      const env = createMockEnv({ omitWorkspaceClaims: true });
      const request = new Request(
        "http://localhost/api/byok/providers/catalog",
        {
          method: "GET",
          headers: await withByokHeaders(env),
        },
      );

      const response = await ProviderController.byokCatalog(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
      expect(data.error.message).toBe("Missing default workspace claim.");
    });

    it("rejects legacy query scope parameters", async () => {
      const env = createMockEnv();
      const request = new Request(
        `http://localhost/api/byok/providers/catalog?runId=${TEST_RUN_ID}`,
        {
          method: "GET",
          headers: await withByokHeaders(env),
        },
      );

      const response = await ProviderController.byokCatalog(request, env);
      expect(response.status).toBe(400);
    });

    it("returns provider catalog", async () => {
      const env = createMockEnv();
      const request = new Request(
        "http://localhost/api/byok/providers/catalog",
        {
          method: "GET",
          headers: await withByokHeaders(env),
        },
      );

      const response = await ProviderController.byokCatalog(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data.providers)).toBe(true);
      expect(data.providers[0].capabilities.streaming).toBe(true);
    });

    it("returns connections after byok connect", async () => {
      const env = createMockEnv();
      await ProviderController.byokConnect(
        new Request("http://localhost/api/byok/providers/connect", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "openai",
            apiKey: "sk-test-1234567890",
          }),
        }),
        env,
      );

      const response = await ProviderController.byokConnections(
        new Request("http://localhost/api/byok/providers/connections", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(
        data.connections.some(
          (connection: { providerId: string; status: string }) =>
            connection.providerId === "openai" &&
            connection.status === "connected",
        ),
      ).toBe(true);
    });

    it("disconnects a connected provider", async () => {
      const env = createMockEnv();
      await ProviderController.byokConnect(
        new Request("http://localhost/api/byok/providers/connect", {
          method: "POST",
          body: JSON.stringify({
            providerId: "openai",
            apiKey: "sk-test-1234567890",
          }),
          headers: await withByokHeaders(env),
        }),
        env,
      );

      const request = new Request(
        "http://localhost/api/byok/providers/disconnect",
        {
          method: "POST",
          body: JSON.stringify({ providerId: "openai" }),
          headers: await withByokHeaders(env),
        },
      );

      const response = await ProviderController.byokDisconnect(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("disconnected");
      expect(data.providerId).toBe("openai");
    });

    it("returns normalized error envelope for validate on disconnected provider", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokValidate(
        new Request("http://localhost/api/byok/providers/validate", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({ providerId: "openai" }),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("PROVIDER_NOT_CONNECTED");
      expect(data.error.retryable).toBe(false);
      expect(typeof data.error.correlationId).toBe("string");
    });

    it("stores and returns preferences", async () => {
      const env = createMockEnv();
      const patchResponse = await ProviderController.byokPreferences(
        new Request("http://localhost/api/byok/preferences", {
          method: "PATCH",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            defaultProviderId: "groq",
            defaultModelId: "llama-3.3-70b-versatile",
          }),
        }),
        env,
      );
      const patchData = await patchResponse.json();

      expect(patchResponse.status).toBe(200);
      expect(patchData.defaultProviderId).toBe("groq");
      expect(patchData.defaultModelId).toBe("llama-3.3-70b-versatile");
      expect(typeof patchData.updatedAt).toBe("string");

      const getHeaders = await withByokHeaders(env);
      delete getHeaders["Content-Type"];
      const getResponse = await ProviderController.byokGetPreferences(
        new Request("http://localhost/api/byok/preferences", {
          method: "GET",
          headers: getHeaders,
        }),
        env,
      );
      const getData = await getResponse.json();

      expect(getResponse.status).toBe(200);
      expect(getData.defaultProviderId).toBe("groq");
      expect(getData.defaultModelId).toBe("llama-3.3-70b-versatile");
      expect(typeof getData.updatedAt).toBe("string");
    });
  });

  describe("hosted provider discovery isolation", () => {
    async function catalogRequest(env: Env, headers: Record<string, string>) {
      return AppServerController.request(new Request("http://localhost/app-server/request", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/catalog", params: { runId: TEST_RUN_ID } }),
      }), env);
    }
    it("requires an authenticated cookie before runtime discovery", async () => {
      const response = await catalogRequest(createMockEnv(), {});
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("unauthorized");
    });
    it.each([
      { "X-User-Id": "another-user" },
      { "X-Workspace-Id": "another-workspace" },
    ])("rejects unauthorized scope headers %j", async (scopeHeaders) => {
      const env = createMockEnv();
      const response = await catalogRequest(env, { ...await withByokHeaders(env), ...scopeHeaders });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatchObject({ code: "AUTH_FAILED", retryable: false, statusCode: 403 });
    });
  });

  describe("byok v3", () => {
    it("returns the canonical discovery envelope for the selected provider", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: {"runId":TEST_RUN_ID,"providerId":"openrouter","query":{}}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(false);
      expect(data.providerId).toBe("openrouter");
      expect(data.metadata.status).toBe("available");
    });

    it("returns discovered provider model envelope for view queries", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: {"runId":TEST_RUN_ID,"providerId":"openrouter","query":{"view":"popular","limit":"10"}}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(200);
      expect(data.providerId).toBe("openrouter");
      expect(data.view).toBe("popular");
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.metadata.source).toBe("provider_api");
    });

    it("rejects invalid discovery query params before proxying", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: {"runId":TEST_RUN_ID,"providerId":"openrouter","query":{"view":"invalid","limit":"-1"}}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("invalid_request");
    });

    it("rejects empty discovery query params before proxying", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: {"runId":TEST_RUN_ID,"providerId":"openrouter","query":{"view":""}}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("invalid_request");
    });

    it("rejects invalid provider slug before proxying", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: {"runId":TEST_RUN_ID,"providerId":"OpenAI","query":{}}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("invalid_request");
    });

    it("rejects malformed provider slug", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models", params: {"runId":TEST_RUN_ID,"providerId":"%E0%A4%A","query":{}}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("invalid_request");
    });

    it("returns provider registry entries", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/catalog", params: {"runId":TEST_RUN_ID}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result.providers : envelope;

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].providerId).toBeDefined();
      const axisEntry = data.find(
        (entry: { providerId: string }) => entry.providerId === "axis",
      );
      expect(axisEntry).toBeDefined();
      expect(axisEntry.authModes).toContain("platform_managed");
    });

    it("hides axis from provider registry in production", async () => {
      const env = createMockEnv({ environment: "production" });
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/catalog", params: {"runId":TEST_RUN_ID}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result.providers : envelope;

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      const axisEntry = data.find(
        (entry: { providerId: string }) => entry.providerId === "axis",
      );
      expect(axisEntry).toBeUndefined();
    });

    it("surfaces catalog runtime errors as typed provider errors", async () => {
      const env = createMockEnv({ catalogError: true });
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/catalog", params: {"runId":TEST_RUN_ID}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result.providers : envelope;

      expect(response.status).toBe(500);
      expect(data.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(data.error.message).toContain("Provider catalog unavailable");
    });

    it("surfaces connection runtime errors as typed provider errors", async () => {
      const env = createMockEnv({ connectionsError: true });
      const response = await ProviderController.byokCredentials(
        new Request("http://localhost/api/byok/credentials", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(data.error.message).toContain("Provider connections unavailable");
    });

    it("does not expose axis virtual credentials in production", async () => {
      const env = createMockEnv({ environment: "production" });
      const response = await ProviderController.byokCredentials(
        new Request("http://localhost/api/byok/credentials", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(
        data.some(
          (entry: { providerId: string }) => entry.providerId === "axis",
        ),
      ).toBe(false);
    });

    it("surfaces catalog runtime errors during resolution as typed provider errors", async () => {
      const env = createMockEnv({ catalogError: true });
      const response = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(data.error.message).toContain("Provider catalog unavailable");
    });

    it("refreshes models for a provider", async () => {
      const env = createMockEnv();
      const response = await AppServerController.request(new Request("http://localhost/app-server/request", { method: "POST", headers: await withByokHeaders(env), body: JSON.stringify({protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "provider/models/refresh", params: {"runId":TEST_RUN_ID,"providerId":"openrouter"}}) }), env);
      const envelope = await response.json();
      const data = envelope.ok ? envelope.result : envelope;

      expect(response.status).toBe(200);
      expect(data.providerId).toBe("openrouter");
      expect(data.source).toBe("provider_api");
      expect(data.cacheInvalidated).toBe(true);
    });

    it("connects credential and resolves selection", async () => {
      const env = createMockEnv();
      const connectResponse = await ProviderController.byokConnectCredential(
        new Request("http://localhost/api/byok/credentials", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "openai",
            secret: "sk-test-NOT-A-REAL-KEY-1234567890",
            label: "Primary",
          }),
        }),
        env,
      );
      const connectData = await connectResponse.json();

      expect(connectResponse.status).toBe(200);
      expect(connectData.providerId).toBe("openai");
      expect(connectData.label).toBe("Primary");

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(200);
      expect(resolveData.providerId).toBe("openai");
      expect(resolveData.credentialId).toBe(connectData.credentialId);
      expect(resolveData.modelId).toBe("gpt-4o");
      expect(resolveData.contextWindow).toBe(128_000);
      expect(resolveData.pricing).toEqual({
        inputPer1M: 2.5,
        outputPer1M: 10,
        currency: "USD",
      });
    });

    it("connects credential when model discovery returns no selectable models", async () => {
      const env = createMockEnv({ emptyCatalogProviders: ["openrouter"] });
      const connectResponse = await ProviderController.byokConnectCredential(
        new Request("http://localhost/api/byok/credentials", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "openrouter",
            secret: "sk-or-test-NOT-A-REAL-KEY-1234567890",
            label: "OpenRouter",
          }),
        }),
        env,
      );
      const connectData = await connectResponse.json();

      expect(connectResponse.status).toBe(200);
      expect(connectData.providerId).toBe("openrouter");
      expect(connectData.label).toBe("OpenRouter");
    });

    it("forwards Cloudflare AI connection config to the runtime", async () => {
      const connectRequests: Array<{
        providerId: ProviderId;
        apiKey?: string;
        config?: ProviderConnectionConfig;
      }> = [];
      const env = createMockEnv({ connectRequests });
      const config: ProviderConnectionConfig = {
        providerId: "cloudflare-ai",
        accountId: "account_123",
        gatewayId: "gateway-123",
        routeMode: "ai-gateway",
      };

      const connectResponse = await ProviderController.byokConnectCredential(
        new Request("http://localhost/api/byok/credentials", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "cloudflare-ai",
            secret: "cf-test-token-1234567890",
            label: "Cloudflare",
            config,
          }),
        }),
        env,
      );
      const connectData = await connectResponse.json();

      expect(connectResponse.status).toBe(200);
      expect(connectData.providerId).toBe("cloudflare-ai");
      expect(connectRequests).toEqual([
        {
          providerId: "cloudflare-ai",
          apiKey: "cf-test-token-1234567890",
          config,
        },
      ]);
    });

    it("resolves axis platform defaults when no BYOK credential is selected in staging", async () => {
      const env = createMockEnv({ environment: "staging" });

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(200);
      expect(resolveData.providerId).toBe("axis");
      expect(resolveData.resolvedAt).toBe("platform_defaults");
      expect(resolveData.quota).toEqual({
        used: 0,
        limit: 5,
        resetsAt: "2026-03-12T00:00:00.000Z",
      });
    });

    it("ignores failed provider connection states during resolve selection", async () => {
      const env = createMockEnv({
        environment: "staging",
        failedConnectionProviders: ["axis"],
      });

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(400);
      expect(resolveData.error.code).toBe("AUTH_FAILED");
      expect(resolveData.error.message).toContain(
        "Missing AXIS_OPENROUTER_API_KEY",
      );
    });

    it("returns provider unavailable when session repository reads fail", async () => {
      const env = createMockEnv({ sessionsGetError: true });

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(503);
      expect(resolveData.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(resolveData.error.retryable).toBe(true);
      expect(resolveData.error.message).toContain(
        "Session store is temporarily unavailable",
      );
    });

    it("disables implicit axis fallback in production", async () => {
      const env = createMockEnv({ environment: "production" });

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(400);
      expect(resolveData.error.code).toBe("PROVIDER_NOT_CONNECTED");
      expect(resolveData.error.message).toContain("provider");
    });

    it("returns recovery guidance when axis platform credential is unavailable in staging", async () => {
      const env = createMockEnv({
        axisConnected: false,
        environment: "staging",
      });

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({}),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(400);
      expect(resolveData.error.code).toBe("AUTH_FAILED");
      expect(resolveData.error.message).toContain(
        "Missing AXIS_OPENROUTER_API_KEY",
      );
      expect(resolveData.error.message).toContain(
        "Connect a BYOK API-key provider",
      );
    });

    it("fails fast when session-selected provider is not connected", async () => {
      const env = createMockEnv();
      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({ providerId: "openai" }),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(400);
      expect(resolveData.error.code).toBe("PROVIDER_NOT_CONNECTED");
      expect(resolveData.error.message).toContain("openai");
    });

    it("does not leak workspace default model into a different session-selected provider", async () => {
      const env = createMockEnv();

      const connectOpenai = await ProviderController.byokConnectCredential(
        new Request("http://localhost/api/byok/credentials", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "openai",
            secret: "sk-test-openai-1234567890",
          }),
        }),
        env,
      );
      expect(connectOpenai.status).toBe(200);

      const connectGroq = await ProviderController.byokConnectCredential(
        new Request("http://localhost/api/byok/credentials", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "groq",
            secret: "gsk-test-groq-1234567890",
          }),
        }),
        env,
      );
      expect(connectGroq.status).toBe(200);

      const patchResponse = await ProviderController.byokPreferencesV3(
        new Request("http://localhost/api/byok/preferences", {
          method: "PATCH",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            defaultProviderId: "groq",
            defaultModelId: "llama-3.3-70b-versatile",
          }),
        }),
        env,
      );
      expect(patchResponse.status).toBe(200);

      const resolveResponse = await ProviderController.byokResolve(
        new Request("http://localhost/api/byok/resolve", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({ providerId: "openai" }),
        }),
        env,
      );
      const resolveData = await resolveResponse.json();

      expect(resolveResponse.status).toBe(200);
      expect(resolveData.providerId).toBe("openai");
      expect(resolveData.modelId).toBe("gpt-4o");
      expect(resolveData.resolvedAt).toBe("session_preference");
    });

    it("rejects fallback preference fields in v3 endpoints", async () => {
      const env = createMockEnv();
      const patchResponse = await ProviderController.byokPreferencesV3(
        new Request("http://localhost/api/byok/preferences", {
          method: "PATCH",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            fallbackMode: "allow_fallback",
            fallbackChain: ["openrouter", "groq"],
          }),
        }),
        env,
      );
      const patchData = await patchResponse.json();

      expect(patchResponse.status).toBe(400);
      expect(patchData.error.code).toBe("VALIDATION_ERROR");
    });

    it("disconnects credential by credentialId", async () => {
      const env = createMockEnv();
      const connectResponse = await ProviderController.byokConnectCredential(
        new Request("http://localhost/api/byok/credentials", {
          method: "POST",
          headers: await withByokHeaders(env),
          body: JSON.stringify({
            providerId: "groq",
            secret: "gsk_test_provider_state_1234567890",
          }),
        }),
        env,
      );
      const connectData = await connectResponse.json();

      const disconnectHeaders = await withByokHeaders(env);
      delete disconnectHeaders["Content-Type"];
      const disconnectResponse =
        await ProviderController.byokDisconnectCredential(
          new Request(
            `http://localhost/api/byok/credentials/${connectData.credentialId}`,
            {
              method: "DELETE",
              headers: disconnectHeaders,
            },
          ),
          env,
        );

      expect(disconnectResponse.status).toBe(204);
    });
  });
});

describe("hosted App Server credentials", () => {
  async function call(env: Env, operation: string, params: Record<string, unknown>, headers?: HeadersInit) {
    const response = await AppServerController.request(new Request("http://localhost/app-server/request", {
      method: "POST", headers: headers ?? await withByokHeaders(env),
      body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: `provider/credentials/${operation}`, params: { runId: TEST_RUN_ID, ...params } }),
    }), env);
    return { status: response.status, body: await response.json() };
  }

  it("connects, lists, labels, validates and disconnects through the authenticated boundary", async () => {
    const env = createMockEnv();
    const secret = "sk-test-NOT-A-REAL-KEY-1234567890";
    const connected = await call(env, "connect", { request: { providerId: "openai", secret, label: "Primary" } });
    expect(connected.status).toBe(200);
    expect(connected.body.ok).toBe(true);
    const credentialId = connected.body.result.credentialId;
    expect(connected.body.result).toMatchObject({ providerId: "openai", label: "Primary", userId: TEST_USER_ID, workspaceId: TEST_WORKSPACE_ID, encryptedSecretJson: "{}" });
    expect(JSON.stringify(connected.body)).not.toContain(secret);
    const listed = await call(env, "list", {});
    expect(listed.body.result).toContainEqual(expect.objectContaining({ credentialId }));
    const updated = await call(env, "update", { credentialId, request: { label: "Renamed" } });
    expect(updated.body.result.label).toBe("Renamed");
    const validated = await call(env, "validate", { credentialId, request: { mode: "format" } });
    expect(validated.body.result).toMatchObject({ credentialId, valid: true });
    const disconnected = await call(env, "disconnect", { credentialId });
    expect(disconnected.body.result).toEqual({ disconnected: true });
    const remaining = await call(env, "list", {});
    expect(remaining.body.result).not.toContainEqual(expect.objectContaining({ credentialId }));
    const missing = await call(env, "validate", { credentialId, request: { mode: "format" } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("INTERNAL_ERROR");
    expect(missing.body.error.message).toContain("was not found");
  });

  it.each([
    ["connect", "/providers/connect", "POST"],
    ["connect", "/providers/preferences", "PATCH"],
    ["update", "/providers/preferences/credential-labels", "POST"],
    ["disconnect", "/providers/disconnect", "POST"],
    ["disconnect", "label-delete", "DELETE"],
  ])("surfaces %s failure at %s without claiming success", async (operation, path, method) => {
    const failure = { path, method, enabled: false };
    const env = createMockEnv({ mutationFailure: failure });
    let credentialId: string | undefined;
    if (operation !== "connect") {
      const connected = await call(env, "connect", { request: { providerId: "openai", secret: "test-secret", label: "Primary" } });
      credentialId = connected.body.result.credentialId;
      if (path === "label-delete") failure.path = `/providers/preferences/credential-labels/${credentialId}`;
    }
    failure.enabled = true;
    const params = operation === "connect" ? { request: { providerId: "openai", secret: "test-secret" } } : operation === "update" ? { credentialId, request: { label: "Updated" } } : { credentialId };
    const result = await call(env, operation, params);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true, statusCode: 503 } });
    if (path === "/providers/connect") {
      expect((await call(env, "list", {})).body.result.some((entry: { providerId: string }) => entry.providerId === "openai")).toBe(false);
    }
    if (operation === "update" || path === "/providers/disconnect") {
      expect((await call(env, "list", {})).body.result).toContainEqual(expect.objectContaining({ credentialId, label: "Primary" }));
    }
  });

  it("rejects unauthenticated credential commands", async () => {
    const result = await call(createMockEnv(), "list", {}, { "content-type": "application/json" });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("unauthorized");
  });

  it("rejects missing authenticated workspace claims", async () => {
    const result = await call(createMockEnv({ omitWorkspaceClaims: true }), "list", {});
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects another viewer or workspace scope", async () => {
    const env = createMockEnv();
    for (const [name, value] of [["X-User-Id", "another-viewer"], ["X-Workspace-Id", "another-workspace"]]) {
      const headers = new Headers(await withByokHeaders(env));
      headers.set(name!, value!);
      const result = await call(env, "list", {}, headers);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("AUTH_FAILED");
    }
  });

  it("rejects caller-supplied tenancy and invalid credential intent before dispatch", async () => {
    const env = createMockEnv();
    for (const params of [
      { userId: "another-viewer" }, { workspaceId: "another-workspace" },
      { runId: "invalid" },
    ]) {
      expect((await call(env, "list", params)).status).toBe(400);
    }
    expect((await call(env, "connect", { request: { providerId: "openai", secret: "" } })).status).toBe(400);
  });

  it("preserves production policy and normalized upstream failures", async () => {
    const production = await call(createMockEnv({ environment: "production" }), "list", {});
    expect(production.body.result.some((entry: { providerId: string }) => entry.providerId === "axis")).toBe(false);
    const failed = await call(createMockEnv({ connectionsError: true }), "list", {});
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, statusCode: 500 });
  });
});
