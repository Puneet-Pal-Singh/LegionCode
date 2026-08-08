/**
 * ProviderAdapterFactory - Build provider adapters for inference
 *
 * Single Responsibility: Create and configure provider adapters.
 * Encapsulates adapter instantiation logic, removing it from AIService.
 *
 * Strict Mode (default):
 *   - Unknown default provider throws error
 *
 * No generic provider fallback is allowed. Provider identity selects the
 * direct registered adapter.
 */

import type { Env } from "../../types/ai";
import {
  LiteLLMAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  type ProviderAdapter,
} from "../providers";
import {
  resolveOpenAIKey,
  resolveAnthropicKey,
  resolveOpenRouterKey,
  resolveGroqKey,
  resolveLiteLLMKey,
  resolveProviderKey,
} from "./ProviderKeyValidator";
import { ValidationError } from "../../domain/errors";

/**
 * Build the default provider adapter based on env configuration.
 *
 * Strict Mode (default):
 *   - Unknown LLM_PROVIDER throws ProviderError
 *
 * Provider identity is required for runtime adapter dispatch.
 *
 * @param env - Cloudflare environment
 * @returns Configured ProviderAdapter
 * @throws ProviderError in strict mode if provider is unknown or env vars are missing
 */
export function createDefaultAdapter(env: Env): ProviderAdapter {
  const provider = env.LLM_PROVIDER ?? "openai";
  const creator = DEFAULT_PROVIDER_ADAPTER_CREATORS[provider];
  if (!creator) {
    throw new ValidationError(
      `Unknown LLM provider: "${provider}". Supported providers: ${Object.keys(DEFAULT_PROVIDER_ADAPTER_CREATORS).join(", ")}`,
      "UNKNOWN_PROVIDER",
    );
  }
  return creator(env);
}

/**
 * Create LiteLLM adapter with proper configuration.
 * @param env - Cloudflare environment
 * @param overrideApiKey - Optional override key for BYOK
 * @throws ProviderError if required env vars are missing
 */
export function createLiteLLMAdapter(
  env: Env,
  overrideApiKey?: string,
): LiteLLMAdapter {
  const { apiKey, baseURL } = resolveLiteLLMKey(env, overrideApiKey);
  const defaultModel = resolveDefaultModel(env);

  return new LiteLLMAdapter({
    apiKey,
    baseURL,
    defaultModel,
  });
}

/**
 * Create OpenAI adapter with proper configuration.
 * @param env - Cloudflare environment
 * @param overrideApiKey - Optional override key for BYOK
 * @throws ProviderError if required env vars are missing
 */
export function createOpenAIAdapter(
  env: Env,
  overrideApiKey?: string,
  baseURL?: string,
  providerId = "openai",
): OpenAIAdapter {
  const resolved = resolveOpenAIKey(env, overrideApiKey);

  return new OpenAIAdapter({
    apiKey: resolved.apiKey,
    baseURL: baseURL ?? resolved.baseURL,
    defaultModel: env.DEFAULT_MODEL,
    providerId,
  });
}

/**
 * Create Anthropic adapter with proper configuration.
 * @param env - Cloudflare environment
 * @param overrideApiKey - Optional override key for BYOK
 * @throws ProviderError if required env vars are missing
 */
export function createAnthropicAdapter(
  env: Env,
  overrideApiKey?: string,
): AnthropicAdapter {
  const apiKey = resolveAnthropicKey(env, overrideApiKey);

  return new AnthropicAdapter({
    apiKey,
    defaultModel: env.DEFAULT_MODEL,
  });
}

export function createGoogleAdapter(
  env: Env,
  overrideApiKey?: string,
  baseURL?: string,
): GoogleAdapter {
  const resolved = resolveProviderKey(
    "google-native",
    env,
    overrideApiKey,
    "google",
  );

  return new GoogleAdapter({
    apiKey: resolved.apiKey,
    baseURL: baseURL ?? resolved.baseURL,
    defaultModel: env.DEFAULT_MODEL,
  });
}

/**
 * Create OpenRouter adapter with direct endpoint.
 * Uses user's BYOK for direct inference.
 * @param overrideApiKey - The API key from ProviderConfigService
 * @throws ProviderError if key is missing or invalid format
 */
export function createOpenRouterAdapter(
  overrideApiKey?: string,
): OpenAIAdapter {
  const { apiKey, baseURL } = resolveOpenRouterKey(overrideApiKey);

  return new OpenAIAdapter({
    apiKey,
    baseURL,
    defaultModel: undefined, // OpenRouter handles model in request
    providerId: "openrouter",
  });
}

/**
 * Create Groq adapter with direct endpoint.
 * Uses user's BYOK for direct inference.
 * @param overrideApiKey - The API key from ProviderConfigService
 * @throws ProviderError if key is missing or invalid format
 */
export function createGroqAdapter(overrideApiKey?: string): OpenAIAdapter {
  const { apiKey, baseURL } = resolveGroqKey(overrideApiKey);

  return new OpenAIAdapter({
    apiKey,
    baseURL,
    defaultModel: undefined, // Groq handles model in request
    providerId: "groq",
  });
}

function resolveDefaultModel(env: Env): string {
  if (env.DEFAULT_MODEL) {
    return env.DEFAULT_MODEL;
  }
  throw new ValidationError(
    "DEFAULT_MODEL is required when using LLM_PROVIDER=litellm.",
    "MISSING_DEFAULT_MODEL",
  );
}

export const SUPPORTED_DEFAULT_PROVIDERS = ["litellm", "openai", "anthropic"] as const;

const DEFAULT_PROVIDER_ADAPTER_CREATORS: Record<string, (env: Env) => ProviderAdapter> = {
  litellm: (env) => createLiteLLMAdapter(env),
  openai: (env) => createOpenAIAdapter(env),
  anthropic: (env) => createAnthropicAdapter(env),
};
