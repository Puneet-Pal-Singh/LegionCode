import { describe, expect, it } from "vitest";
import {
  PROVIDER_ENDPOINTS,
  getProviderBaseURL,
  validateProviderApiKeyFormat,
} from "./ProviderEndpointPolicy";

describe("ProviderEndpointPolicy", () => {
  it("derives direct BYOK endpoints from the canonical provider registry", () => {
    expect(Object.keys(PROVIDER_ENDPOINTS).sort()).toEqual([
      "groq",
      "openrouter",
    ]);
    expect(getProviderBaseURL("openrouter")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(getProviderBaseURL("openai")).toBeUndefined();
  });

  it("uses canonical key prefixes for direct providers", () => {
    expect(() =>
      validateProviderApiKeyFormat("groq", "gsk_valid"),
    ).not.toThrow();
    expect(() => validateProviderApiKeyFormat("groq", "invalid")).toThrow(
      'Key must start with "gsk_"',
    );
  });
});
