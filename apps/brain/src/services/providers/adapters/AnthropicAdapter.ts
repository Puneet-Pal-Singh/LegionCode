// apps/brain/src/services/providers/adapters/AnthropicAdapter.ts
// Phase 3.1: Direct Anthropic provider adapter with standardized usage

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText, type CoreMessage, type CoreTool } from "ai";
import type {
  ProviderAdapter,
  GenerationParams,
  GenerationResult,
  StreamChunk,
} from "../base/ProviderAdapter";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import { PROVIDER_SDK_MAX_RETRIES } from "../ProviderRequestPolicy";

interface AnthropicConfig {
  apiKey: string;
  defaultModel?: string;
}

/**
 * Anthropic Adapter - Direct Anthropic API integration
 *
 * Features:
 * - Standardizes token usage to LLMUsage format
 * - Returns cost-calculable metadata
 * - Supports both streaming and non-streaming generation
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic";
  readonly supportedModels: string[];
  private client: ReturnType<typeof createAnthropic>;
  private defaultModel: string;

  constructor(config: AnthropicConfig) {
    this.client = createAnthropic({
      apiKey: config.apiKey,
    });
    this.defaultModel = config.defaultModel ?? "claude-3-sonnet-20240229";
    this.supportedModels = [];
  }

  supportsModel(model: string): boolean {
    if (this.supportedModels.length === 0) {
      return true;
    }
    return this.supportedModels.includes(model);
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const model = params.model ?? this.defaultModel;

    const result = await generateText({
      model: this.client(model),
      messages: params.messages,
      system: params.system,
      tools: params.tools,
      temperature: params.temperature,
      abortSignal: params.signal,
      maxRetries: PROVIDER_SDK_MAX_RETRIES,
    });

    // Standardize usage to LLMUsage format
    const usage = this.standardizeUsage(result.usage, model);

    return {
      content: result.text,
      usage,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls?.map((tc) => ({
        toolCallId: readToolCallId(tc),
        toolName: tc.toolName,
        args: tc.args,
      })),
    };
  }

  async *generateStream(
    params: GenerationParams,
  ): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
    const model = params.model ?? this.defaultModel;

    const streamResult = streamText({
      model: this.client(model),
      messages: params.messages,
      system: params.system,
      tools: params.tools,
      temperature: params.temperature,
      abortSignal: params.signal,
      maxRetries: PROVIDER_SDK_MAX_RETRIES,
    });

    let fullText = "";
    let finalUsage: LLMUsage | undefined;
    let finishReason: string | undefined;

    for await (const chunk of streamResult.fullStream) {
      switch (chunk.type) {
        case "text-delta":
          fullText += chunk.textDelta;
          yield {
            type: "text",
            content: chunk.textDelta,
          };
          break;

        case "tool-call":
          yield {
            type: "tool-call",
            toolCall: {
              toolCallId: readToolCallId(chunk),
              toolName: chunk.toolName,
              args: chunk.args,
            },
          };
          break;

        case "finish":
          finishReason = chunk.finishReason;
          // Usage available at finish
          if (chunk.usage) {
            finalUsage = this.standardizeUsage(chunk.usage, model);
            yield {
              type: "finish",
              usage: finalUsage,
              finishReason: chunk.finishReason,
            };
          }
          break;
      }
    }

    // Get final result
    const [finalUsageResult, finalText, finalFinishReason, finalToolCalls] =
      await Promise.all([
        streamResult.usage,
        streamResult.text,
        streamResult.finishReason,
        streamResult.toolCalls,
      ]);

    if (!finalUsage) {
      finalUsage = this.standardizeUsage(finalUsageResult, model);
    }

    return {
      content: fullText || finalText,
      usage: finalUsage,
      finishReason: finishReason ?? finalFinishReason,
      toolCalls: finalToolCalls?.map(
        (tc: { toolName: string; args: unknown }) => ({
          toolCallId: readToolCallId(tc),
          toolName: tc.toolName,
          args: tc.args,
        }),
      ),
    };
  }

  /**
   * Standardize AI SDK usage to LLMUsage format
   */
  private standardizeUsage(
    usage: { promptTokens: number; completionTokens: number },
    model: string,
  ): LLMUsage {
    return {
      provider: this.provider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      // Anthropic doesn't provide cost directly, PricingRegistry will calculate
      raw: usage,
    };
  }
}

function readToolCallId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { toolCallId?: unknown; id?: unknown };
  if (typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return record.toolCallId.trim();
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  return undefined;
}
