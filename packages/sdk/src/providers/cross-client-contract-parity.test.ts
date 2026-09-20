import { describe, expect, it, vi } from "vitest";
import { createProviderClient } from "./client.js";
import { ProviderClientOperationError } from "./errors.js";
import { createByokHttpTransport } from "./http-transport.js";
import { createByokCloudTransport } from "./cloud-transport.js";

const BASE_URL = "http://localhost:8788/api/byok";

describe("provider client cross-client parity", () => {
  it("returns identical catalog contracts for web and desktop cloud transports", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse(200, [
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
        },
      ]),
    ) as unknown as typeof fetch;

    const webClient = createProviderClient(
      createByokHttpTransport({
        baseUrl: BASE_URL,
        getRunId: () => "run_web001",
        fetchImpl,
      }),
    );
    const desktopClient = createProviderClient(
      createByokCloudTransport({
        baseUrl: BASE_URL,
        getRunId: () => "run_desktop001",
        getAccessToken: () => "desktop-token",
        fetchImpl,
      }),
    );

    const [webCatalog, desktopCatalog] = await Promise.all([
      webClient.discoverProviders(),
      desktopClient.discoverProviders(),
    ]);

    expect(webCatalog).toEqual(desktopCatalog);
  });

  it("normalizes server envelope errors identically for web and desktop cloud transports", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse(429, {
        error: {
          code: "PROVIDER_RATE_LIMITED",
          message: "Too many requests",
          retryable: true,
        },
      }),
    ) as unknown as typeof fetch;

    const webClient = createProviderClient(
      createByokHttpTransport({
        baseUrl: BASE_URL,
        getRunId: () => "run_web001",
        fetchImpl,
      }),
    );
    const desktopClient = createProviderClient(
      createByokCloudTransport({
        baseUrl: BASE_URL,
        getRunId: () => "run_desktop001",
        getAccessToken: () => "desktop-token",
        fetchImpl,
      }),
    );

    const [webError, desktopError] = await Promise.all([
      getOperationError(() => webClient.discoverProviders()),
      getOperationError(() => desktopClient.discoverProviders()),
    ]);

    expect(webError.code).toBe(desktopError.code);
    expect(webError.retryable).toBe(desktopError.retryable);
    expect(webError.statusCode).toBe(desktopError.statusCode);
    expect(webError.message).toBe(desktopError.message);
  });
});

async function getOperationError(
  run: () => Promise<unknown>,
): Promise<ProviderClientOperationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProviderClientOperationError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected operation to fail");
}

function createJsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
