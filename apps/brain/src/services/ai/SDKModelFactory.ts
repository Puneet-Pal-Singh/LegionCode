/**
 * SDKModelFactory - Configuration for creating AI SDK model instances
 *
 * Single Responsibility: Provide configuration and provider selection logic
 * for SDK model creation. Does NOT directly import AI SDK (to comply with
 * eslint no-restricted-imports rule). Actual SDK instantiation happens in AIService.
 */

import type { Env } from "../../types/ai";
import { ProviderError } from "../providers";
import { resolveProviderKey } from "./ProviderKeyValidator";
import type { RuntimeProvider } from "./ModelSelectionPolicy";

/**
 * SDK model configuration for a given provider/model combination.
 * Used by AIService to create actual SDK model instances.
 */
export interface SDKModelConfig {
  provider: RuntimeProvider;
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * Get SDK model configuration for structured generation.
 * Resolves provider, API key, and endpoint. Does NOT instantiate SDK models.
 *
 * @param model - The model name to use
 * @param provider - The runtime provider type
 * @param env - Cloudflare environment
 * @param overrideApiKey - Optional override API key for BYOK
 * @returns Configuration for SDK model instantiation
 * @throws ProviderError if provider is not supported or keys are missing
 */
export function getSDKModelConfig(
  model: string,
  provider: RuntimeProvider,
  env: Env,
  overrideApiKey?: string,
  providerId?: string,
  baseURLOverride?: string,
): SDKModelConfig {
  const { apiKey, baseURL } = resolveProviderKeyForSDK(
    provider,
    env,
    overrideApiKey,
    providerId,
  );

  return {
    provider,
    apiKey,
    baseURL: baseURLOverride ?? baseURL,
    model,
  };
}

/**
 * Resolve API key and base URL for SDK use.
 * @param provider - The provider type
 * @param env - Cloudflare environment
 * @param overrideApiKey - Optional override key
 * @returns { apiKey, baseURL }
 * @throws ProviderError if key is missing
 */
function resolveProviderKeyForSDK(
  provider: RuntimeProvider,
  env: Env,
  overrideApiKey?: string,
  providerId?: string,
): { apiKey: string; baseURL: string } {
  if (provider === "anthropic-native") {
    const apiKey = overrideApiKey ?? env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ProviderError("anthropic", "Missing ANTHROPIC_API_KEY");
    }
    // Anthropic doesn't use baseURL in the same way, but we include for consistency
    return { apiKey, baseURL: "https://api.anthropic.com" };
  }

  // For all other providers, use the standard resolver
  return resolveProviderKey(provider, env, overrideApiKey, providerId);
}
