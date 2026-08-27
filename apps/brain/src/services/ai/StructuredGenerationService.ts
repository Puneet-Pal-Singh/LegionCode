/**
 * StructuredGenerationService - Configuration for structured generation
 *
 * Single Responsibility: Provide configuration and parameters for structured
 * generation. Does NOT import or call AI SDK directly (to comply with
 * eslint no-restricted-imports rule). Actual SDK calls happen in AIService.
 */

import type { CoreMessage } from "ai";
import type { ZodSchema } from "zod";
import type { LLMUsage } from "@legioncode/execution-engine/runtime/cost";
import type { RuntimeProvider } from "./ModelSelectionPolicy";
import type { SDKModelConfig } from "./SDKModelFactory";
import { inferUsageProvider } from "./usage-provider";

/**
 * Result from structured generation with usage
 */
export interface GenerateStructuredResult<T> {
  object: T;
  usage: LLMUsage;
}

/**
 * Structured generation request configuration.
 * Prepared by this service, executed by AIService.
 */
export interface StructuredGenerationRequest<T> {
  sdkModelConfig: SDKModelConfig;
  messages: CoreMessage[];
  schema: ZodSchema<T>;
  temperature: number;
}

/**
 * Prepare structured generation request configuration.
 * Does NOT execute the request - AIService handles that.
 *
 * @param model - The model name to use
 * @param provider - The runtime provider type
 * @param messages - The messages to send
 * @param schema - The Zod schema for output validation
 * @param temperature - Temperature setting (default 0.2)
 * @returns Configuration ready for SDK execution
 */
export function prepareStructuredGenerationRequest<T>({
  model,
  provider,
  messages,
  schema,
  sdkModelConfig,
  temperature = 0.2,
}: {
  model: string;
  provider: RuntimeProvider;
  messages: CoreMessage[];
  schema: ZodSchema<T>;
  sdkModelConfig: SDKModelConfig;
  temperature?: number;
}): StructuredGenerationRequest<T> {
  return {
    sdkModelConfig,
    messages,
    schema,
    temperature,
  };
}

export function getStructuredGenerationMode(
  provider: RuntimeProvider,
): "json" | undefined {
  if (
    provider === "anthropic-native" ||
    provider === "google-native"
  ) {
    return undefined;
  }

  return "json";
}

export function buildStructuredGenerationUsage({
  provider,
  providerId,
  baseURL,
  model,
  usage,
}: {
  provider: RuntimeProvider;
  providerId?: string;
  baseURL: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}): LLMUsage {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;

  return {
    provider: inferUsageProvider(provider, providerId, baseURL),
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
