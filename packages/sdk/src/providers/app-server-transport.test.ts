import { describe, expect, it, vi } from "vitest";
import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { createProviderClient } from "./client.js";
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
