/**
 * ProviderKeyValidator - API key and endpoint resolution for provider families.
 */

import type { ProviderAdapterFamily } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { ProviderError } from "@legioncode/execution-engine/runtime/provider";
import {
  GROQ_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
} from "./defaults";
import { ProviderRegistryService } from "../providers";

const registryService = new ProviderRegistryService();

export function resolveAxisOpenRouterKey(env: Env): {
  apiKey: string;
  baseURL: string;
} {
  const apiKey = env.AXIS_OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new ProviderError(
      "axis",
      "Missing AXIS_OPENROUTER_API_KEY for platform-managed Axis provider.",
    );
  }

  if (!registryService.isApiKeyFormatValid("openrouter", apiKey)) {
    throw new ProviderError(
      "axis",
      "Invalid AXIS_OPENROUTER_API_KEY format for platform-managed Axis provider.",
    );
  }

  return {
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
  };
}

export function resolveOpenAIKey(
  env: Env,
  overrideApiKey?: string,
): { apiKey: string; baseURL: string } {
  const apiKey = overrideApiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderError("openai", "Missing OPENAI_API_KEY");
  }
  return {
    apiKey,
    baseURL: OPENAI_BASE_URL,
  };
}

export function resolveAnthropicKey(
  env: Env,
  overrideApiKey?: string,
): string {
  const apiKey = overrideApiKey ?? env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderError("anthropic", "Missing ANTHROPIC_API_KEY");
  }
  return apiKey;
}

export function resolveOpenRouterKey(overrideApiKey?: string): {
  apiKey: string;
  baseURL: string;
} {
  if (!overrideApiKey) {
    throw new ProviderError(
      "openrouter",
      "OpenRouter provider is not connected. Please connect your OpenRouter API key in settings.",
    );
  }

  if (!registryService.isApiKeyFormatValid("openrouter", overrideApiKey)) {
    throw new ProviderError("openrouter", "Invalid OpenRouter API key format");
  }

  return {
    apiKey: overrideApiKey,
    baseURL: OPENROUTER_BASE_URL,
  };
}

export function resolveGroqKey(overrideApiKey?: string): {
  apiKey: string;
  baseURL: string;
} {
  if (!overrideApiKey) {
    throw new ProviderError(
      "groq",
      "Groq provider is not connected. Please connect your Groq API key in settings.",
    );
  }

  if (!registryService.isApiKeyFormatValid("groq", overrideApiKey)) {
    throw new ProviderError("groq", "Invalid Groq API key format");
  }

  return {
    apiKey: overrideApiKey,
    baseURL: GROQ_BASE_URL,
  };
}

/**
 * Resolve LiteLLM credentials with explicit endpoint ownership.
 * No vendor fallback chain: endpoint selection drives required key source.
 */
export function resolveLiteLLMKey(
  env: Env,
  overrideApiKey?: string,
): { apiKey: string; baseURL: string } {
  const baseURL = resolveLiteLLMBaseURL(env);
  if (overrideApiKey) {
    return { apiKey: overrideApiKey, baseURL };
  }

  const apiKey = resolveEnvironmentKeyForBaseURL(env, baseURL);
  if (!apiKey) {
    throw new ProviderError(
      "litellm",
      `Missing API key for configured LITELLM_BASE_URL (${baseURL}).`,
    );
  }

  return { apiKey, baseURL };
}

export function resolveProviderKey(
  providerFamily: ProviderAdapterFamily,
  env: Env,
  overrideApiKey?: string,
  providerId?: string,
): { apiKey: string; baseURL: string } {
  if (providerFamily === "anthropic-native") {
    return {
      apiKey: resolveAnthropicKey(env, overrideApiKey),
      baseURL: "https://api.anthropic.com",
    };
  }

  if (providerFamily === "google-native") {
    const apiKey = overrideApiKey;
    if (!apiKey) {
      throw new ProviderError(
        "google",
        "Google-native runtime requires an explicit connected API key.",
      );
    }
    const baseURL =
      registryService.getProvider(providerId ?? "google")?.baseUrl ??
      "https://generativelanguage.googleapis.com/v1beta";
    return { apiKey, baseURL };
  }

  if (providerFamily === "custom-http") {
    throw new ProviderError(
      providerId ?? "custom-http",
      "Custom HTTP provider family is not wired for runtime inference yet.",
    );
  }

  if (providerId === "openrouter") {
    return resolveOpenRouterKey(overrideApiKey);
  }

  if (providerId === "axis") {
    if (overrideApiKey) {
      throw new ProviderError(
        "axis",
        "Axis is platform-managed and does not accept override API keys.",
      );
    }
    return resolveAxisOpenRouterKey(env);
  }

  if (providerId === "groq") {
    return resolveGroqKey(overrideApiKey);
  }

  if (providerId === "openai" || !providerId) {
    return resolveOpenAIKey(env, overrideApiKey);
  }

  const provider = registryService.getProvider(providerId);
  if (!provider) {
    throw new ProviderError(
      providerId,
      `Provider "${providerId}" is not registered.`,
    );
  }
  if (!overrideApiKey) {
    throw new ProviderError(
      providerId,
      `Provider "${providerId}" is not connected. Please connect your API key.`,
    );
  }
  const baseURL = provider.baseUrl ?? env.LITELLM_BASE_URL ?? OPENAI_BASE_URL;
  return { apiKey: overrideApiKey, baseURL };
}

function resolveLiteLLMBaseURL(env: Env): string {
  if (!env.LITELLM_BASE_URL) {
    throw new ProviderError(
      "litellm",
      "Missing LITELLM_BASE_URL for explicit LiteLLM provider configuration.",
    );
  }
  return env.LITELLM_BASE_URL;
}

function resolveEnvironmentKeyForBaseURL(env: Env, baseURL: string): string | undefined {
  const host = parseHost(baseURL);
  if (!host) {
    return undefined;
  }

  if (host.includes("openrouter.ai")) {
    return env.OPENROUTER_API_KEY;
  }
  if (host.includes("groq.com")) {
    return env.GROQ_API_KEY;
  }
  if (host.includes("openai.com")) {
    return env.OPENAI_API_KEY;
  }

  return env.OPENAI_API_KEY ?? env.GROQ_API_KEY ?? env.OPENROUTER_API_KEY;
}

function parseHost(urlValue: string): string | null {
  try {
    return new URL(urlValue).host.toLowerCase();
  } catch {
    return null;
  }
}
