/**
 * Provider Registry
 *
 * Defines the provider registry contract and base provider metadata.
 * The registry is extensible and NOT tied to a fixed enum.
 *
 * Phase 1: Include axis, openai, groq, openrouter
 * Phase 2+: Add 10+ more providers without schema changes
 */

import { z } from "zod";

export const ProviderAdapterFamilySchema = z.enum([
  "openai-compatible",
  "anthropic-native",
  "google-native",
  "custom-http",
]);
export type ProviderAdapterFamily = z.infer<typeof ProviderAdapterFamilySchema>;

export const ProviderValidationAuthModeSchema = z.enum([
  "bearer",
  "googleApiKey",
  "none",
]);
export type ProviderValidationAuthMode = z.infer<
  typeof ProviderValidationAuthModeSchema
>;

export const ProviderAuthModeSchema = z.enum([
  "api_key",
  "oauth",
  "platform_managed",
]);
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>;

export const ProviderLaunchStageSchema = z.enum([
  "supported",
  "coming_soon",
  "hidden",
]);
export type ProviderLaunchStage = z.infer<typeof ProviderLaunchStageSchema>;

/**
 * ProviderRegistryEntry - Metadata for a provider (static catalog)
 *
 * Does NOT include secrets or connection status.
 * This is pure provider capability/configuration metadata.
 */
export const ProviderRegistryEntrySchema = z.object({
  /** Unique provider identifier (slug format: `openai`, `groq`, `anthropic`, etc.) */
  providerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),

  /** Display name for UI */
  displayName: z.string().min(1).max(256),

  /** Auth modes supported by this provider */
  authModes: z.array(ProviderAuthModeSchema).min(1),

  /** Launch catalog exposure state for truthful provider UX. */
  launchStage: ProviderLaunchStageSchema.optional(),

  /** Optional base URL for custom endpoints */
  baseUrl: z.string().url().optional(),

  /** Key format hints (for validation and UI) */
  keyFormat: z
    .object({
      prefix: z.string().optional(),
      regex: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),

  /** Capability flags */
  capabilities: z.object({
    streaming: z.boolean().default(true),
    tools: z.boolean().default(false),
    jsonMode: z.boolean().default(false),
    structuredOutputs: z.boolean().default(false),
  }),

  /** Adapter family used by runtime inference/discovery dispatch. */
  adapterFamily: ProviderAdapterFamilySchema.default("openai-compatible"),

  /** Model catalog source strategy */
  modelSource: z.enum(["static", "remote"]),

  /** Optional provider-specific model-list endpoint override. */
  modelsEndpoint: z.string().url().optional(),

  /** Optional live validation endpoint metadata. */
  validation: z
    .object({
      endpoint: z.string().url(),
      authMode: ProviderValidationAuthModeSchema.default("bearer"),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),

  /** Default model ID if not specified by user */
  defaultModelId: z.string().optional(),
});

export type ProviderRegistryEntry = z.infer<typeof ProviderRegistryEntrySchema>;

/**
 * ProviderRegistry - Catalog of all available providers
 *
 * This is a static catalog that defines what providers are available.
 * It's separate from user credentials (which are dynamic per workspace).
 */
export const ProviderRegistrySchema = z.object({
  providers: z.array(ProviderRegistryEntrySchema),
  generatedAt: z.string().datetime(),
});

export type ProviderRegistry = z.infer<typeof ProviderRegistrySchema>;

/**
 * Built-in provider registry entries (Phase 1)
 *
 * These are the base providers. New providers can be added via
 * ProviderRegistry without code changes.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderRegistryEntry> = {
  axis: {
    providerId: "axis",
    displayName: "Axis",
    authModes: ["platform_managed"],
    launchStage: "supported",
    baseUrl: "https://openrouter.ai/api/v1",
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "openai-compatible",
    modelSource: "static",
    defaultModelId: "z-ai/glm-4.5-air:free",
  },

  openai: {
    providerId: "openai",
    displayName: "OpenAI",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://api.openai.com/v1",
    keyFormat: {
      prefix: "sk-",
      description: "OpenAI API key (starts with sk-)",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "openai-compatible",
    modelSource: "static",
    modelsEndpoint: "https://api.openai.com/v1/models",
    validation: {
      endpoint: "https://api.openai.com/v1/models",
      authMode: "bearer",
    },
    defaultModelId: "gpt-4o",
  },

  groq: {
    providerId: "groq",
    displayName: "Groq",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://api.groq.com/openai/v1",
    keyFormat: {
      prefix: "gsk_",
      description: "Groq API key (starts with gsk_)",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: false,
      structuredOutputs: false,
    },
    adapterFamily: "openai-compatible",
    modelSource: "static",
    modelsEndpoint: "https://api.groq.com/openai/v1/models",
    validation: {
      endpoint: "https://api.groq.com/openai/v1/models",
      authMode: "bearer",
    },
    defaultModelId: "mixtral-8x7b-32768",
  },

  openrouter: {
    providerId: "openrouter",
    displayName: "OpenRouter",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://openrouter.ai/api/v1",
    keyFormat: {
      prefix: "sk-or-",
      description: "OpenRouter API key (starts with sk-or-)",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "openai-compatible",
    modelSource: "remote",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
    validation: {
      endpoint: "https://openrouter.ai/api/v1/key",
      authMode: "bearer",
      headers: {
        "HTTP-Referer": "https://legioncode.dev",
        "X-Title": "LegionCode BYOK Live Validate",
      },
    },
  },

  anthropic: {
    providerId: "anthropic",
    displayName: "Anthropic",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://api.anthropic.com/v1",
    keyFormat: {
      prefix: "sk-ant-",
      description: "Anthropic API key (starts with sk-ant-)",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: false,
      structuredOutputs: true,
    },
    adapterFamily: "anthropic-native",
    modelSource: "static",
    validation: {
      endpoint: "https://api.anthropic.com/v1/models",
      authMode: "bearer",
    },
    defaultModelId: "claude-3-opus",
  },

  cohere: {
    providerId: "cohere",
    displayName: "Cohere",
    authModes: ["api_key"],
    launchStage: "hidden",
    baseUrl: "https://api.cohere.com",
    keyFormat: {
      description: "Cohere API key",
    },
    capabilities: {
      streaming: true,
      tools: false,
      jsonMode: false,
      structuredOutputs: false,
    },
    adapterFamily: "custom-http",
    modelSource: "remote",
  },

  mistral: {
    providerId: "mistral",
    displayName: "Mistral AI",
    authModes: ["api_key"],
    launchStage: "hidden",
    baseUrl: "https://api.mistral.ai/v1",
    keyFormat: {
      description: "Mistral API key",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: false,
      structuredOutputs: false,
    },
    adapterFamily: "openai-compatible",
    modelSource: "remote",
    modelsEndpoint: "https://api.mistral.ai/v1/models",
    validation: {
      endpoint: "https://api.mistral.ai/v1/models",
      authMode: "bearer",
    },
    defaultModelId: "mistral-large-latest",
  },

  google: {
    providerId: "google",
    displayName: "Google AI (Gemini)",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyFormat: {
      description: "Google AI API key",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: false,
      structuredOutputs: true,
    },
    adapterFamily: "google-native",
    modelSource: "remote",
    modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    validation: {
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
      authMode: "googleApiKey",
    },
    defaultModelId: "gemini-2.5-flash-lite",
  },

  together: {
    providerId: "together",
    displayName: "Together AI",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://api.together.xyz/v1",
    keyFormat: {
      description: "Together AI API key",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "openai-compatible",
    modelSource: "remote",
    modelsEndpoint: "https://api.together.xyz/v1/models",
    validation: {
      endpoint: "https://api.together.xyz/v1/models",
      authMode: "bearer",
    },
  },

  cerebras: {
    providerId: "cerebras",
    displayName: "Cerebras",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://api.cerebras.ai/v1",
    keyFormat: {
      description: "Cerebras API key",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "openai-compatible",
    modelSource: "remote",
    modelsEndpoint: "https://api.cerebras.ai/v1/models",
    validation: {
      endpoint: "https://api.cerebras.ai/v1/models",
      authMode: "bearer",
    },
  },

  "opencode-go": {
    providerId: "opencode-go",
    displayName: "OpenCode Go",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://opencode.ai/zen/go/v1",
    keyFormat: {
      description: "OpenCode Go API key",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "openai-compatible",
    modelSource: "remote",
    modelsEndpoint: "https://opencode.ai/zen/go/v1/models",
    validation: {
      endpoint: "https://opencode.ai/zen/go/v1/models",
      authMode: "bearer",
    },
  },

  "opencode-zen": {
    providerId: "opencode-zen",
    displayName: "OpenCode Zen",
    authModes: ["api_key"],
    launchStage: "supported",
    baseUrl: "https://opencode.ai/zen/v1",
    keyFormat: {
      description: "OpenCode Zen API key",
    },
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "custom-http",
    modelSource: "remote",
    modelsEndpoint: "https://opencode.ai/zen/v1/models",
    validation: {
      endpoint: "https://opencode.ai/zen/v1/models",
      authMode: "bearer",
    },
  },

  "cloudflare-ai": {
    providerId: "cloudflare-ai",
    displayName: "Cloudflare AI",
    authModes: ["api_key"],
    launchStage: "coming_soon",
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
    },
    adapterFamily: "custom-http",
    modelSource: "remote",
  },
};

/**
 * Get builtin registry
 *
 * Returns the static provider registry for Phase 1.
 * Dynamic provider metadata is loaded from canonical Postgres-backed state.
 */
export function getBuiltinRegistry(): ProviderRegistry {
  return {
    providers: Object.values(BUILTIN_PROVIDERS),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Find provider by ID in builtin registry
 *
 * Provider IDs are case-insensitive and normalized to lowercase.
 */
export function findBuiltinProvider(
  providerId: string,
): ProviderRegistryEntry | undefined {
  return BUILTIN_PROVIDERS[providerId.toLowerCase()];
}

/**
 * Validate provider exists in builtin registry
 *
 * Provider IDs are case-insensitive and normalized to lowercase.
 */
export function isKnownProvider(providerId: string): boolean {
  return providerId.toLowerCase() in BUILTIN_PROVIDERS;
}

/**
 * Get all provider IDs in builtin registry
 *
 * Note: All returned IDs are lowercase. Use with `isKnownProvider()` which
 * handles case-insensitive comparison, or manually normalize input before
 * comparing against this list.
 */
export function getKnownProviderIds(): string[] {
  return Object.keys(BUILTIN_PROVIDERS);
}

export function isLaunchVisibleProvider(entry: ProviderRegistryEntry): boolean {
  return (entry.launchStage ?? "hidden") !== "hidden";
}

export function isLaunchSupportedProvider(
  entry: ProviderRegistryEntry,
): boolean {
  return (entry.launchStage ?? "hidden") === "supported";
}

export function getLaunchVisibleProviders(
  entries: ProviderRegistryEntry[] = Object.values(BUILTIN_PROVIDERS),
): ProviderRegistryEntry[] {
  return entries.filter(isLaunchVisibleProvider);
}

export function getLaunchSupportedProviders(
  entries: ProviderRegistryEntry[] = Object.values(BUILTIN_PROVIDERS),
): ProviderRegistryEntry[] {
  return entries.filter(isLaunchSupportedProvider);
}
