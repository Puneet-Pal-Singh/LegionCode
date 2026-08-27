// apps/brain/src/services/providers/adapters/LiteLLMAdapter.ts
// Phase 3.1: LiteLLM provider adapter with standardized usage

import type { LLMUsage } from "@legioncode/execution-engine/runtime/cost";
import {
  OpenAICompatibleAdapter,
  type OpenAICompatibleConfig,
} from "./OpenAICompatibleAdapter";
import {
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  GROQ_BASE_URL,
} from "../../ai/defaults";

interface LiteLLMConfig {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  supportedModels?: string[];
}

export class LiteLLMAdapter extends OpenAICompatibleAdapter {
  readonly provider = "litellm";
  readonly supportedModels: string[];
  private readonly usageProvider: "litellm" | "openrouter" | "groq" | "openai";

  constructor(config: LiteLLMConfig) {
    if (!config.defaultModel || config.defaultModel.trim() === "") {
      throw new Error(
        "[adapter/litellm] defaultModel is required and cannot be empty",
      );
    }

    const adapterConfig: OpenAICompatibleConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultModel: config.defaultModel,
      supportedModels: config.supportedModels ?? [],
    };
    super(adapterConfig);
    this.supportedModels = config.supportedModels ?? [];
    this.usageProvider = inferUsageProviderFromBaseURL(config.baseURL);
  }

  protected standardizeUsage(
    usage: { promptTokens: number; completionTokens: number },
    model: string,
  ): LLMUsage {
    return {
      provider: this.usageProvider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      raw: usage,
    };
  }
}

function inferUsageProviderFromBaseURL(
  baseURL: string,
): "litellm" | "openrouter" | "groq" | "openai" {
  const normalized = baseURL.toLowerCase();

  if (normalized.includes(new URL(OPENROUTER_BASE_URL).host)) {
    return "openrouter";
  }
  if (normalized.includes(new URL(GROQ_BASE_URL).host)) {
    return "groq";
  }
  if (normalized.includes(new URL(OPENAI_BASE_URL).host)) {
    return "openai";
  }
  return "litellm";
}
