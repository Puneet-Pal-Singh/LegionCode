import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@repo/shared-types";
import { ProviderConnectionService } from "./ProviderConnectionService";

function createRegistryMock() {
  const providerIds: ProviderId[] = ["openai", "google"];
  const capabilities = {
    streaming: true,
    tools: true,
    structuredOutputs: true,
    jsonMode: true,
  };

  return {
    listProviderIds: vi.fn(() => providerIds),
    getProviderCapabilities: vi.fn(() => capabilities),
  };
}

describe("ProviderConnectionService", () => {
  it("returns connected/disconnected states when connectivity checks succeed", async () => {
    const credentialService = {
      isConnected: vi.fn(
        async (providerId: ProviderId) => providerId === "openai",
      ),
      getConnectionConfig: vi.fn(async () => undefined),
    };
    const registryService = createRegistryMock();

    const service = new ProviderConnectionService(
      credentialService as never,
      registryService as never,
    );

    const response = await service.getConnections();
    expect(response).toHaveLength(2);
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "openai",
          status: "connected",
        }),
        expect.objectContaining({
          providerId: "google",
          status: "disconnected",
        }),
      ]),
    );
  });

  it("marks providers as failed when credential lookup throws", async () => {
    const credentialService = {
      isConnected: vi.fn(async (providerId: ProviderId) => {
        if (providerId === "google") {
          throw new Error("KV GET failed: 500 Internal Server Error");
        }
        return providerId === "openai";
      }),
      getConnectionConfig: vi.fn(async () => undefined),
    };
    const registryService = createRegistryMock();

    const service = new ProviderConnectionService(
      credentialService as never,
      registryService as never,
    );

    const response = await service.getConnections();
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "google",
          status: "failed",
          errorCode: "PROVIDER_UNAVAILABLE",
          errorMessage:
            "Credential store is temporarily unavailable for this provider.",
        }),
        expect.objectContaining({
          providerId: "openai",
          status: "connected",
        }),
      ]),
    );
  });
});
