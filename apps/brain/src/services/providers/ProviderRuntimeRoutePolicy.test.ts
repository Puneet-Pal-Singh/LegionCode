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

  it("routes provider-prefixed OpenAI reasoning models through Responses", () => {
    expect(resolveProviderRuntimeRoute("openai", "openai/gpt-5.1")).toEqual({
      runtimeModelId: "gpt-5.1",
      providerTransport: "openai-responses",
      providerEndpoint: "https://api.openai.com/v1/responses",
    });
  });

  it("uses Responses for every OpenAI model without model-name matching", () => {
    expect(resolveProviderRuntimeRoute("openai", "gpt-4o")).toEqual({
      runtimeModelId: "gpt-4o",
      providerTransport: "openai-responses",
      providerEndpoint: "https://api.openai.com/v1/responses",
    });
  });

  it("keeps other providers on their registered adapter", () => {
    expect(
      resolveProviderRuntimeRoute("openrouter", "openai/gpt-5.6-luna"),
    ).toBeUndefined();
  });
});
