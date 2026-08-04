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

  it("preserves canonical context metadata for the selected provider tuple", () => {
    expect(
      resolveSelectedProviderConfig({
        selectedProviderId: "openai",
        selectedModelId: "gpt-4o",
        selectedCredentialId: "cred-a",
        lastResolvedConfig: {
          providerId: "openai",
          modelId: "gpt-4o",
          credentialId: "cred-a",
          contextWindow: 128_000,
        },
      }),
    ).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      credentialId: "cred-a",
      contextWindow: 128_000,
      source: "store_selection",
    });
  });

  it("does not borrow context metadata from a different provider tuple", () => {
    expect(
      resolveSelectedProviderConfig({
        selectedProviderId: "openai",
        selectedModelId: "gpt-4o",
        selectedCredentialId: "cred-a",
        lastResolvedConfig: {
          providerId: "openai",
          modelId: "gpt-4o-mini",
          credentialId: "cred-a",
          contextWindow: 128_000,
        },
      }),
    ).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      credentialId: "cred-a",
      source: "store_selection",
    });
  });

  it("uses selected model context and pricing metadata before cached resolution", () => {
    expect(
      resolveSelectedProviderConfig({
        selectedProviderId: "openai",
        selectedModelId: "gpt-5",
        selectedCredentialId: "cred-a",
        selectedModelContextWindow: 400_000,
        selectedModelPricing: {
          inputPer1M: 1.25,
          outputPer1M: 10,
          currency: "USD",
        },
        lastResolvedConfig: {
          providerId: "openai",
          modelId: "gpt-5",
          credentialId: "cred-a",
        },
      }),
    ).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
      credentialId: "cred-a",
      contextWindow: 400_000,
      pricing: {
        inputPer1M: 1.25,
        outputPer1M: 10,
        currency: "USD",
      },
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
