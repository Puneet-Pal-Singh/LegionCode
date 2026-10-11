import { describe, expect, it, vi } from "vitest";
import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { createProviderClient } from "./client.js";
import { createByokHttpTransport } from "./http-transport.js";
import { createProviderAppServerTransport } from "./app-server-transport.js";

const runId = "run_123456";
function response(method: string, result: unknown) {
  return Response.json({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    method,
    ok: true,
    result,
  });
}

describe("hosted provider AppServer transport", () => {
  it.each([401, 429, 503])(
    "preserves existing non-JSON HTTP %s error behavior",
    async (status) => {
      const options = {
        baseUrl: "https://brain.test/api/byok",
        getRunId: () => runId,
        fetchImpl: async () =>
          new Response("Upstream temporarily unavailable", {
            status,
            headers: { "content-type": "text/plain" },
          }),
      };
      const capture = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          throw new Error("Expected error");
        } catch (error) {
          return error;
        }
      };
      const previous = await capture(() =>
        createByokHttpTransport(options).discoverProviders(),
      );
      const current = await capture(() =>
        createProviderAppServerTransport({
          ...options,
          appServerBaseUrl: "https://brain.test",
        }).discoverProviders(),
      );
      expect(current).toMatchObject(previous as object);
      expect(current).toMatchObject({
        code: "INVALID_ERROR_RESPONSE",
        statusCode: status,
        retryable: status >= 500 || status === 429,
      });
    },
  );

  it("preserves malformed JSON error status and retry guidance", async () => {
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl: async () =>
          new Response('{"error":', {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      }),
    );
    await expect(client.discoverProviders()).rejects.toMatchObject({
      code: "INVALID_ERROR_RESPONSE",
      statusCode: 503,
      retryable: false,
    });
  });

  it("retains the full discovery query, cookie authorization and canonical run scope", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.credentials).toBe("include");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          method: "provider/models",
          params: {
            runId,
            providerId: "openrouter",
            query: {
              view: "all",
              surface: "manage",
              limit: 150,
              cursor: "page/2+token",
            },
          },
        });
        return response("provider/models", {
          providerId: "openrouter",
          view: "all",
          models: [],
          page: { limit: 150, hasMore: true, nextCursor: "page3" },
          metadata: {
            fetchedAt: "2026-10-10T00:00:00.000Z",
            stale: true,
            source: "provider_api",
          },
        });
      },
    );
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl,
      }),
    );
    const page = await client.discoverProviderModels("openrouter", {
      view: "all",
      limit: 150,
      cursor: "page/2+token",
      ...{ surface: "manage" },
    });
    expect(page.page.nextCursor).toBe("page3");
    expect(page.metadata.stale).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://brain.test/app-server/request",
    );
  });

  it("preserves normalized provider errors, retryability, correlation and HTTP status", async () => {
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl: async () =>
          Response.json(
            {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              method: "provider/catalog",
              ok: false,
              error: {
                code: "PROVIDER_UNAVAILABLE",
                message: "Catalog unavailable",
                retryable: true,
                correlationId: "catalog-123",
                statusCode: 503,
              },
            },
            { status: 503 },
          ),
      }),
    );
    await expect(client.discoverProviders()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      statusCode: 503,
      correlationId: "catalog-123",
    });
  });

  it("rejects mismatched method errors instead of accepting their provider payload", async () => {
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl: async () =>
          Response.json(
            {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              method: "provider/models",
              ok: false,
              error: {
                code: "PROVIDER_UNAVAILABLE",
                message: "Wrong operation",
                retryable: true,
                statusCode: 503,
              },
            },
            { status: 503 },
          ),
      }),
    );
    await expect(client.discoverProviders()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("keeps discovery responses uncapped and refresh scoped to the same run", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body));
        expect(envelope.params.runId).toBe(runId);
        if (envelope.method === "provider/models/refresh")
          return response(envelope.method, {
            providerId: "openrouter",
            refreshedAt: "2026-10-10T00:00:00.000Z",
            source: "provider_api",
            cacheInvalidated: true,
            modelsCount: 150,
          });
        return response("provider/models", {
          providerId: "openrouter",
          view: "all",
          models: Array.from({ length: 150 }, (_, i) => ({
            id: `model-${i}`,
            name: "x".repeat(8000),
            providerId: "openrouter",
          })),
          page: { limit: 150, hasMore: false },
          metadata: {
            fetchedAt: "2026-10-10T00:00:00.000Z",
            stale: false,
            source: "provider_api",
          },
        });
      },
    );
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl,
      }),
    );
    expect(
      (
        await client.discoverProviderModels("openrouter", {
          view: "all",
          limit: 150,
        })
      ).models,
    ).toHaveLength(150);
    expect(
      (await client.refreshProviderModels("openrouter")).cacheInvalidated,
    ).toBe(true);
  });
});

describe("hosted credential transport", () => {
  const credentialId = "550e8400-e29b-41d4-a716-446655440000";
  const credential = {
    credentialId,
    userId: "viewer",
    workspaceId: "workspace",
    providerId: "openai",
    label: "Primary",
    keyFingerprint: "masked-1234",
    encryptedSecretJson: "{}",
    keyVersion: "v2",
    status: "connected",
    lastValidatedAt: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    deletedAt: null,
  };

  it("routes all five operations with canonical run scope and cookie credentials", async () => {
    const envelopes: Array<{
      method: string;
      params: Record<string, unknown>;
    }> = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.credentials).toBe("include");
        const envelope = JSON.parse(String(init?.body));
        envelopes.push(envelope);
        const result = envelope.method.endsWith("/list")
          ? [credential]
          : envelope.method.endsWith("/disconnect")
            ? { disconnected: true }
            : envelope.method.endsWith("/validate")
              ? { credentialId, valid: true, validatedAt: credential.updatedAt }
              : credential;
        return response(envelope.method, result);
      },
    );
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl,
      }),
    );
    expect(await client.listCredentials()).toEqual([credential]);
    expect(
      await client.connectCredential({
        providerId: "openai",
        secret: "test-secret",
      }),
    ).toEqual(credential);
    await client.updateCredential(credentialId, { label: "Updated" });
    await client.validateCredential(credentialId, { mode: "live" });
    await client.disconnectCredential(credentialId);
    expect(envelopes.map((e) => e.method)).toEqual(
      ["list", "connect", "update", "validate", "disconnect"].map(
        (m) => `provider/credentials/${m}`,
      ),
    );
    for (const e of envelopes) expect(e.params.runId).toBe(runId);
    expect(envelopes[1]?.params.request).toEqual({
      providerId: "openai",
      secret: "test-secret",
    });
    expect(envelopes[2]?.params).toMatchObject({
      credentialId,
      request: { label: "Updated" },
    });
    expect(envelopes[3]?.params).toMatchObject({
      credentialId,
      request: { mode: "live" },
    });
    expect(
      fetchImpl.mock.calls.every(
        ([url]) => url === "https://brain.test/app-server/request",
      ),
    ).toBe(true);
  });

  it("rejects malformed credential metadata and mismatched response methods", async () => {
    for (const wireResponse of [
      response("provider/credentials/list", [
        { ...credential, credentialId: "invalid" },
      ]),
      response("provider/credentials/connect", credential),
    ]) {
      const client = createProviderClient(
        createProviderAppServerTransport({
          baseUrl: "https://brain.test/api/byok",
          appServerBaseUrl: "https://brain.test",
          getRunId: () => runId,
          fetchImpl: async () => wireResponse,
        }),
      );
      await expect(client.listCredentials()).rejects.toMatchObject({
        code: "INVALID_RESPONSE_CONTRACT",
      });
    }
  });

  it("preserves cancellation while connecting", async () => {
    const controller = new AbortController();
    const client = createProviderClient(
      createProviderAppServerTransport({
        baseUrl: "https://brain.test/api/byok",
        appServerBaseUrl: "https://brain.test",
        getRunId: () => runId,
        fetchImpl: async (_input, init) => {
          expect(init?.signal?.aborted).toBe(false);
          controller.abort();
          expect(init?.signal?.aborted).toBe(true);
          throw new DOMException("Aborted", "AbortError");
        },
      }),
    );
    await expect(
      client.connectCredential(
        { providerId: "openai", secret: "test-secret" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
});
