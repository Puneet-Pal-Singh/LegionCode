// apps/brain/src/services/providers/base/ProviderAdapter.ts
// Phase 3.1: Base interface for all LLM provider adapters

import type { CoreMessage, CoreTool, TextStreamPart } from "ai";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";

/**
 * Parameters for generation
 */
export interface GenerationParams {
  messages: CoreMessage[];
  system?: string;
  tools?: Record<string, CoreTool>;
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Result from generation with standardized usage
 */
export interface GenerationResult {
  content: string;
  usage: LLMUsage;
  finishReason?: string;
  toolCalls?: Array<{
    toolCallId?: string;
    toolName: string;
    args: unknown;
  }>;
}

/**
 * Stream chunk result
 */
export interface StreamChunk {
  type: "text" | "tool-call" | "finish";
  content?: string;
  toolCall?: {
    toolCallId?: string;
    toolName: string;
    args: unknown;
  };
  usage?: LLMUsage;
  finishReason?: string;
}

/**
 * Base interface for all LLM provider adapters
 *
 * All adapters must:
 * 1. Standardize token usage to LLMUsage format
 * 2. Return cost-calculable metadata
 * 3. Support both streaming and non-streaming generation
 */
export interface ProviderAdapter {
  readonly provider: string;
  readonly supportedModels: string[];

  /**
   * Generate text completion
   * Returns standardized result with LLMUsage
   */
  generate(params: GenerationParams): Promise<GenerationResult>;

  /**
   * Generate streaming text completion
   * Yields standardized chunks
   */
  generateStream(
    params: GenerationParams,
  ): AsyncGenerator<StreamChunk, GenerationResult, unknown>;

  /**
   * Check if adapter supports a specific model
   */
  supportsModel(model: string): boolean;
}

/**
 * Error for provider-specific issues
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[provider/${provider}] ${message}`);
    this.name = "ProviderError";
  }
}
