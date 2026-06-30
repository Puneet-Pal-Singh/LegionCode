import { describe, it, expect } from "vitest";
import { ProviderController } from "./ProviderController";
import type { Env } from "../types/ai";
import type { ProviderId } from "@repo/shared-types";

const TEST_RUN_ID = "run_123e4567e89b42d3a456426614174000";
const TEST_USER_ID = "user-123";
const TEST_WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174111";
const TEST_SESSION_SECRET = "test-session-secret";
const TEST_SESSION_TOKEN = "test-session-token";

function createMockEnv(options?: {
  axisConnected?: boolean;
  catalogError?: boolean;
  connectionsError?: boolean;
  failedConnectionProviders?: ProviderId[];
  emptyCatalogProviders?: ProviderId[];
  preferencesError?: boolean;
  sessionsGetError?: boolean;
  omitWorkspaceClaims?: boolean;
  environment?: "production" | "staging" | "development";
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

  const catalog: Record<ProviderId, Array<{ id: string; name: string }>> = {
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
    openai: [{ id: "gpt-4o", name: "GPT-4o" }],
    openrouter: [{ id: "openrouter/auto", name: "Auto" }],
    groq: [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" }],
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

        const scopeKey = `${userId}:${workspaceId}`;
        if (!providerState.has(scopeKey)) {
          providerState.set(scopeKey, new Set<ProviderId>());
        }
        const connectedProviders = providerState.get(scopeKey)!;

        if (
          url.pathname === "/providers/connect" &&
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
              ["axis", "openrouter", "openai", "groq"] as ProviderId[]
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
              id: model.id,
              name: model.name,
              providerId: providerId,
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
              ["axis", "openrouter", "openai", "groq"] as ProviderId[]
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
    Cookie: `shadowbox_session=${TEST_SESSION_TOKEN}`,
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

  describe("byok v3", () => {
    it("returns provider models for selected provider", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviderModels(
        new Request("http://localhost/api/byok/providers/openrouter/models", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].id).toBe("openrouter/auto");
    });

    it("returns discovered provider model envelope for view queries", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviderModels(
        new Request(
          "http://localhost/api/byok/providers/openrouter/models?view=popular&limit=10",
          {
            method: "GET",
            headers: await withByokHeaders(env),
          },
        ),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.providerId).toBe("openrouter");
      expect(data.view).toBe("popular");
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.metadata.source).toBe("provider_api");
    });

    it("rejects invalid discovery query params before proxying", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviderModels(
        new Request(
          "http://localhost/api/byok/providers/openrouter/models?view=invalid&limit=-1",
          {
            method: "GET",
            headers: await withByokHeaders(env),
          },
        ),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects empty discovery query params before proxying", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviderModels(
        new Request(
          "http://localhost/api/byok/providers/openrouter/models?view=",
          {
            method: "GET",
            headers: await withByokHeaders(env),
          },
        ),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid provider slug in path before proxying", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviderModels(
        new Request("http://localhost/api/byok/providers/OpenAI/models", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects malformed percent-encoded provider slug", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviderModels(
        new Request("http://localhost/api/byok/providers/%E0%A4%A/models", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns provider registry entries", async () => {
      const env = createMockEnv();
      const response = await ProviderController.byokProviders(
        new Request("http://localhost/api/byok/providers", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

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
      const response = await ProviderController.byokProviders(
        new Request("http://localhost/api/byok/providers", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      const axisEntry = data.find(
        (entry: { providerId: string }) => entry.providerId === "axis",
      );
      expect(axisEntry).toBeUndefined();
    });

    it("surfaces catalog runtime errors as typed provider errors", async () => {
      const env = createMockEnv({ catalogError: true });
      const response = await ProviderController.byokProviders(
        new Request("http://localhost/api/byok/providers", {
          method: "GET",
          headers: await withByokHeaders(env),
        }),
        env,
      );
      const data = await response.json();

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
      const response = await ProviderController.byokRefreshProviderModels(
        new Request(
          "http://localhost/api/byok/providers/openrouter/models/refresh",
          {
            method: "POST",
            headers: await withByokHeaders(env),
          },
        ),
        env,
      );
      const data = await response.json();

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
