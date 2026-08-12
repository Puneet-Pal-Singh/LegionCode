// apps/brain/src/services/providers/adapters/OpenAIAdapter.ts
// Phase 3.1: Direct OpenAI provider adapter with standardized usage

import { createOpenAI } from "@ai-sdk/openai";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import {
  OpenAICompatibleAdapter,
  type OpenAICompatibleConfig,
} from "./OpenAICompatibleAdapter";

interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  providerId?: string;
  headers?: Record<string, string>;
}

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  readonly provider: string;
  readonly supportedModels: string[];

  constructor(config: OpenAIConfig) {
    const adapterConfig: OpenAICompatibleConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultModel: config.defaultModel ?? "gpt-4o-mini",
      supportedModels: [],
      headers: config.headers,
    };
    super(adapterConfig);
    this.provider = config.providerId ?? "openai";
    this.supportedModels = [];
  }

  protected standardizeUsage(
    usage: { promptTokens: number; completionTokens: number },
    model: string,
  ): LLMUsage {
    return {
      provider: this.provider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      raw: usage,
    };
  }
}
