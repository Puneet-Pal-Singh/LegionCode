import { describe, expect, it, vi } from "vitest";
import { createProviderClient } from "./client.js";
import { createByokCloudTransport } from "./cloud-transport.js";
import { createByokHttpTransport } from "./http-transport.js";

const BASE_URL = "http://localhost:8788/api/byok";
const PROVIDER_ID = "openai";
const CREDENTIAL_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("provider client cross-client lifecycle parity", () => {
  it("keeps lifecycle outputs and request sequence aligned across web and cloud transports", async () => {
    const webMock = createLifecycleFetchMock();
    const cloudMock = createLifecycleFetchMock();

    const webClient = createProviderClient(
      createByokHttpTransport({
        baseUrl: BASE_URL,
        getRunId: () => "run_web001",
        fetchImpl: webMock.fetchImpl,
      }),
    );
    const cloudClient = createProviderClient(
      createByokCloudTransport({
        baseUrl: BASE_URL,
        getRunId: () => "run_desktop001",
        getAccessToken: () => "desktop-token",
        fetchImpl: cloudMock.fetchImpl,
      }),
    );

    const [webResult, cloudResult] = await Promise.all([
      runLifecycleScenario(webClient),
      runLifecycleScenario(cloudClient),
    ]);

    expect(webResult).toEqual(cloudResult);
    expect(webMock.calls).toEqual(cloudMock.calls);
  });
});

async function runLifecycleScenario(
  client: ReturnType<typeof createProviderClient>,
): Promise<Record<string, unknown>> {
  const providers = await client.discoverProviders();
  const models = await client.discoverProviderModels(PROVIDER_ID, {
    view: "popular",
    limit: 20,
  });
  const refresh = await client.refreshProviderModels(PROVIDER_ID);
  const credentials = await client.listCredentials();
  const connected = await client.connectCredential({
    providerId: PROVIDER_ID,
    secret: "sk-test",
    label: "Primary",
  });
  const updated = await client.updateCredential(CREDENTIAL_ID, {
    label: "Updated",
  });
  const validated = await client.validateCredential(CREDENTIAL_ID, {
    mode: "format",
  });
  const preferences = await client.getPreferences();
  const selected = await client.selectDefault({
    defaultProviderId: PROVIDER_ID,
    defaultModelId: "gpt-4o",
  });
  const resolved = await client.resolveForRun({
    providerId: PROVIDER_ID,
    modelId: "gpt-4o",
  });
  await client.disconnectCredential(CREDENTIAL_ID);

  return {
    providers,
    models,
    refresh,
    credentials,
    connected,
    updated,
    validated,
    preferences,
    selected,
    resolved,
  };
}

function createLifecycleFetchMock(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = toUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}${url.search}`);

    if (method === "GET" && url.pathname === "/api/byok/providers") {
      return createJsonResponse(200, [
        {
          providerId: "openai",
          displayName: "OpenAI",
          authModes: ["api_key"],
          capabilities: {
            streaming: true,
            tools: true,
            jsonMode: true,
            structuredOutputs: true,
          },
          adapterFamily: "openai-compatible",
          modelSource: "static",
          defaultModelId: "gpt-4o",
        },
      ]);
    }

    if (
      method === "GET" &&
      url.pathname === `/api/byok/providers/${PROVIDER_ID}/models`
    ) {
      return createJsonResponse(200, {
        providerId: PROVIDER_ID,
        view: "popular",
        models: [
          {
            id: "gpt-4o",
            name: "GPT-4o",
            providerId: PROVIDER_ID,
          },
        ],
        page: {
          limit: 20,
          cursor: undefined,
          nextCursor: undefined,
          hasMore: false,
        },
        metadata: {
          fetchedAt: "2026-03-07T00:00:00.000Z",
          stale: false,
          source: "provider_api",
        },
      });
    }

    if (
      method === "POST" &&
      url.pathname === `/api/byok/providers/${PROVIDER_ID}/models/refresh`
    ) {
      return createJsonResponse(200, {
        providerId: PROVIDER_ID,
        refreshedAt: "2026-03-07T00:00:00.000Z",
        source: "provider_api",
        cacheInvalidated: true,
        modelsCount: 1,
      });
    }

    if (method === "GET" && url.pathname === "/api/byok/credentials") {
      return createJsonResponse(200, [createCredentialFixture("Primary")]);
    }

    if (method === "POST" && url.pathname === "/api/byok/credentials") {
      return createJsonResponse(200, createCredentialFixture("Primary"));
    }

    if (
      method === "PATCH" &&
      url.pathname === `/api/byok/credentials/${CREDENTIAL_ID}`
    ) {
      return createJsonResponse(200, createCredentialFixture("Updated"));
    }

    if (
      method === "POST" &&
      url.pathname === `/api/byok/credentials/${CREDENTIAL_ID}/validate`
    ) {
      return createJsonResponse(200, {
        credentialId: CREDENTIAL_ID,
        valid: true,
        validatedAt: "2026-03-07T00:00:00.000Z",
      });
    }

    if (method === "GET" && url.pathname === "/api/byok/preferences") {
      return createJsonResponse(200, createPreferenceFixture());
    }

    if (method === "PATCH" && url.pathname === "/api/byok/preferences") {
      return createJsonResponse(200, createPreferenceFixture());
    }

    if (method === "POST" && url.pathname === "/api/byok/resolve") {
      return createJsonResponse(200, {
        providerId: PROVIDER_ID,
        credentialId: CREDENTIAL_ID,
        modelId: "gpt-4o",
        resolvedAt: "workspace_preference",
        resolvedAtTime: "2026-03-07T00:00:00.000Z",
      });
    }

    if (
      method === "DELETE" &&
      url.pathname === `/api/byok/credentials/${CREDENTIAL_ID}`
    ) {
      return new Response(null, { status: 204 });
    }

    return createJsonResponse(500, {
      error: {
        code: "INTERNAL_ERROR",
        message: `Unhandled mock route: ${method} ${url.pathname}`,
      },
    });
  });

  return {
    fetchImpl: fetchMock as unknown as typeof fetch,
    calls,
  };
}

function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function createJsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createCredentialFixture(label: string): Record<string, unknown> {
  return {
    credentialId: CREDENTIAL_ID,
    userId: "user-1",
    workspaceId: "workspace-1",
    providerId: PROVIDER_ID,
    label,
    keyFingerprint: "sk-****1234",
    encryptedSecretJson: "{}",
    keyVersion: "v1",
    status: "connected",
    lastValidatedAt: null,
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z",
    deletedAt: null,
  };
}

function createPreferenceFixture(): Record<string, unknown> {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    defaultProviderId: PROVIDER_ID,
    defaultModelId: "gpt-4o",
    visibleModelIds: { [PROVIDER_ID]: ["gpt-4o"] },
    updatedAt: "2026-03-07T00:00:00.000Z",
  };
}
