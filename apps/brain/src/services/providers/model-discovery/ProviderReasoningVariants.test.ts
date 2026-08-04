import { describe, expect, it } from "vitest";
import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import {
  enrichProviderReasoningVariants,
  resolveCatalogReasoningEfforts,
} from "./ProviderReasoningVariants";

const model: BYOKDiscoveredProviderModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  providerId: "openai",
};

describe("ProviderReasoningVariants", () => {
  it("derives OpenCode-style GPT-5.6 variants for OpenAI", () => {
    expect(resolveCatalogReasoningEfforts("openai", model.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("derives the same upstream variants for OpenRouter OpenAI models", () => {
    expect(
      resolveCatalogReasoningEfforts("openrouter", "openai/gpt-5.6-luna"),
    ).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  it("does not replace explicit provider effort metadata", () => {
    const explicit = {
      ...model,
      capabilities: {
        supportsReasoning: true,
        reasoningEfforts: ["light"],
      },
    };
    expect(enrichProviderReasoningVariants("openai", explicit)).toBe(explicit);
  });

  it("marks derived variants as platform catalog metadata", () => {
    expect(enrichProviderReasoningVariants("openai", model)).toMatchObject({
      capabilities: {
        supportsReasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      },
      capabilityMetadata: {
        source: "platform_registry",
        confidence: "declared",
      },
    });
  });

  it("replaces legacy static effort metadata in cached models", () => {
    const legacy = {
      ...model,
      capabilities: {
        supportsReasoning: true,
        reasoningEfforts: ["none", "minimal", "low", "medium", "high", "max"],
      },
      capabilityMetadata: {
        source: "static_override" as const,
        confidence: "declared" as const,
      },
    };

    expect(enrichProviderReasoningVariants("openai", legacy)).toMatchObject({
      capabilities: {
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      },
      capabilityMetadata: { source: "platform_registry" },
    });
  });
});
