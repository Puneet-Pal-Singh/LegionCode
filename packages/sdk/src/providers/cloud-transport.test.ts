import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { describe, expect, it, vi } from "vitest";
import { createByokCloudTransport } from "./cloud-transport.js";

describe("createByokCloudTransport", () => {
  it("uses omit credentials and injects bearer token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "provider/catalog",
      ok: true,
      result: { providers: [] },
    })) as unknown as typeof fetch;
    const transport = createByokCloudTransport({
      appServerBaseUrl: "http://localhost:8788",
      getRunId: () => "run_123456",
      getAccessToken: () => "desktop-token",
      getHeaders: () => ({ "X-Client-Id": "desktop" }),
      fetchImpl,
    });

    await transport.discoverProviders();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8788/app-server/request",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.any(Headers),
        method: "POST",
      }),
    );
    const headers = new Headers(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer desktop-token");
    expect(headers.get("X-Client-Id")).toBe("desktop");
    expect(headers.get("X-Run-Id")).toBe("run_123456");
  });

  it("keeps explicit Authorization header when provided", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "provider/catalog",
      ok: true,
      result: { providers: [] },
    })) as unknown as typeof fetch;
    const transport = createByokCloudTransport({
      appServerBaseUrl: "http://localhost:8788",
      getRunId: () => "run_123456",
      getAccessToken: () => "token-should-not-override",
      getHeaders: () => ({ Authorization: "Bearer explicit-token" }),
      fetchImpl,
    });

    await transport.discoverProviders();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8788/app-server/request",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = new Headers(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer explicit-token");
  });

  it("keeps explicit authorization header regardless of casing", async () => {
    let capturedRequestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequestInit = init;
      return Response.json({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "provider/catalog",
        ok: true,
        result: { providers: [] },
      });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const transport = createByokCloudTransport({
      appServerBaseUrl: "http://localhost:8788",
      getRunId: () => "run_123456",
      getAccessToken: () => "token-should-not-override",
      getHeaders: () => ({ authorization: "Bearer explicit-lowercase-token" }),
      fetchImpl,
    });

    await transport.discoverProviders();

    const headers = new Headers(capturedRequestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer explicit-lowercase-token");
  });
});
