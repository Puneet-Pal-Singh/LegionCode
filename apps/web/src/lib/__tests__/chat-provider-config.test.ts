import { describe, expect, it } from "vitest";
import {
  requireResolvedProviderConfig,
  resolveSelectedProviderConfig,
} from "../chat-provider-config";

describe("resolveSelectedProviderConfig", () => {
  it("uses the complete selected provider tuple before cached config", () => {
    expect(
      resolveSelectedProviderConfig({
        selectedProviderId: " axis ",
        selectedModelId: " model-a ",
        selectedCredentialId: " cred-a ",
        lastResolvedConfig: {
          providerId: "cached-axis",
          modelId: "cached-model",
          credentialId: "cached-cred",
        },
      }),
    ).toEqual({
      providerId: "axis",
      modelId: "model-a",
      credentialId: "cred-a",
      source: "store_selection",
    });
  });

  it("does not mix partial selected config with cached config", () => {
    expect(
      resolveSelectedProviderConfig({
        selectedProviderId: "new-axis",
        selectedModelId: "",
        selectedCredentialId: null,
        lastResolvedConfig: {
          providerId: "cached-axis",
          modelId: "cached-model",
          credentialId: "cached-cred",
        },
      }),
    ).toEqual({
      providerId: "cached-axis",
      modelId: "cached-model",
      credentialId: "cached-cred",
      source: "store_selection",
    });
  });
});

describe("requireResolvedProviderConfig", () => {
  it("throws when resolved provider config is incomplete", () => {
    expect(() =>
      requireResolvedProviderConfig({
        providerId: "axis",
        modelId: "",
        credentialId: "cred-a",
        source: "provider_resolve_api",
      }),
    ).toThrow("Provider resolution failed");
  });
});
