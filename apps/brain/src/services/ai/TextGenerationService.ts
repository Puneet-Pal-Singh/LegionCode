/**
 * TextGenerationService - Pure text generation service
 *
 * Single Responsibility: Generate text responses using provider adapters.
 * Returns standardized LLMUsage for cost tracking.
 */

import type { CoreMessage, CoreTool } from "ai";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import type { ProviderAdapter, GenerationParams } from "../providers";
import type { ReasoningEffort } from "@repo/shared-types";

/**
 * Result from text generation with usage
 */
export interface GenerateTextResult {
  text: string;
  usage: LLMUsage;
  finishReason?: string;
  toolCalls?: Array<{
    toolCallId?: string;
    toolName: string;
    args: unknown;
  }>;
}

/**
 * Generate text using a provider adapter.
 *
 * @param adapter - The provider adapter to use
 * @param params - Generation parameters
 * @returns Result with text, usage, and finish reason
 */
export async function generateText(
  adapter: ProviderAdapter,
  params: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, CoreTool>;
    temperature?: number;
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort;
    model: string;
    signal?: AbortSignal;
  },
): Promise<GenerateTextResult> {
  const generationParams: GenerationParams = {
    messages: params.messages,
    system: params.system,
    tools: params.tools,
    temperature: params.temperature,
    maxOutputTokens: params.maxOutputTokens,
    reasoningEffort: params.reasoningEffort,
    model: params.model,
    signal: params.signal,
  };

  const result = await adapter.generate(generationParams);

  return {
    text: result.content,
    usage: result.usage,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
  };
}
