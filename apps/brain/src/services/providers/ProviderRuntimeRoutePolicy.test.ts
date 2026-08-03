import { describe, expect, it } from "vitest";
import { resolveProviderRuntimeRoute } from "./ProviderRuntimeRoutePolicy";

describe("resolveProviderRuntimeRoute", () => {
  it("routes newly discovered OpenAI reasoning models through Responses", () => {
    expect(resolveProviderRuntimeRoute("openai", "gpt-5.6-luna")).toEqual({
      runtimeModelId: "gpt-5.6-luna",
      providerTransport: "openai-responses",
      providerEndpoint: "https://api.openai.com/v1/responses",
    });
  });

  it("keeps legacy OpenAI and OpenRouter models on their registered adapter", () => {
    expect(resolveProviderRuntimeRoute("openai", "gpt-4o")).toBeUndefined();
    expect(
      resolveProviderRuntimeRoute("openrouter", "openai/gpt-5.6-luna"),
    ).toBeUndefined();
  });
});
