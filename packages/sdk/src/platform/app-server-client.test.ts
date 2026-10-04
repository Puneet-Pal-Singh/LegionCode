import { describe, expect, it } from "vitest";

import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import {
  AppServerClientError,
  createAppServerClient,
  type AppServerRequest,
} from "./app-server-client.js";

describe("AppServerClient", () => {
  it("sends a validated versioned envelope and returns a validated result", async () => {
    let sent: AppServerRequest | undefined;
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope) => {
          sent = envelope;
          return {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "initialize",
            ok: true,
            result: {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              server: { id: "local", version: "0.1.0" },
              environment: "local",
              capabilities: [],
              unavailableCapabilities: [],
            },
          };
        },
      },
    });

    const response = await client.initialize(["workspace-selection-v1"]);

    expect(sent).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "initialize",
      params: {
        client: { id: "desktop", version: "0.1.0" },
        requestedCapabilities: ["workspace-selection-v1"],
      },
    });
    expect(response.environment).toBe("local");
  });

  it("uses opaque workspace selection tokens and rejects invalid server results", async () => {
    let sent: AppServerRequest | undefined;
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope) => {
          sent = envelope;
          return {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "workspace/grant",
            ok: true,
            result: { grant: null },
          };
        },
      },
    });

    await expect(client.grantWorkspace({ selectionToken: "selection-token" })).rejects.toMatchObject({
      code: "invalid_response",
    } satisfies Partial<AppServerClientError>);
    expect(sent).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "workspace/grant",
      params: { selectionToken: "selection-token" },
    });
  });

  it.each([
    { protocolVersion: "2.0.0", method: "initialize", ok: true, result: {} },
    { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", ok: true, result: { threads: [] } },
    { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "initialize", ok: true, result: { server: {} } },
  ])("rejects malformed, mismatched, or invalid operation responses", async (response) => {
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: { request: async () => response },
    });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "AppServerClientError",
      code: "invalid_response",
    });
  });

  it("wraps transport failures in a typed client error", async () => {
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: { request: async () => { throw new Error("private transport detail"); } },
    });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "AppServerClientError",
      code: "transport",
    } satisfies Partial<AppServerClientError>);
  });

  it("uses correlated App Server methods and validates provider catalog and selection results", async () => {
    const sent: AppServerRequest[] = [];
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope) => {
          sent.push(envelope);
          const results: Record<string, unknown> = {
            "provider/catalog": { providers: [] },
            "provider/models": {
              providerId: "openai",
              view: "popular",
              models: [],
              page: { limit: 1, hasMore: false },
              metadata: { fetchedAt: "2026-10-04T00:00:00.000Z", stale: false, source: "registry", status: "available" },
            },
            "provider/current": { selection: null },
            "provider/select": { selection: { providerId: "openai", modelId: "gpt-4o" } },
            "provider/clear": { selection: null },
          };
          return {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: envelope.method,
            ok: true,
            result: results[envelope.method],
          };
        },
      },
    });

    await expect(client.getProviderCatalog()).resolves.toEqual([]);
    await expect(client.getProviderModels("openai")).resolves.toMatchObject({ providerId: "openai", metadata: { source: "registry" } });
    await expect(client.getProviderSelection()).resolves.toBeNull();
    await expect(client.selectProvider("openai", "gpt-4o")).resolves.toEqual({ providerId: "openai", modelId: "gpt-4o" });
    await expect(client.clearProviderSelection()).resolves.toBeNull();
    expect(sent.map(({ method }) => method)).toEqual([
      "provider/catalog",
      "provider/models",
      "provider/current",
      "provider/select",
      "provider/clear",
    ]);
    expect(sent[3]).toMatchObject({ params: { providerId: "openai", modelId: "gpt-4o" } });
  });
});
