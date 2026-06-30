import { z } from "zod";
import {
  BUILTIN_PROVIDERS,
  ProviderCapabilityFlagsSchema,
  ProviderIdSchema,
  ProviderRegistryEntrySchema,
  type ProviderRegistryEntry,
} from "@repo/shared-types";

export const ProviderRegistryCapabilitySchema =
  ProviderCapabilityFlagsSchema.extend({
    vision: z.boolean(),
    reasoning: z.boolean(),
    reasoningSummary: z.boolean(),
  });
export type ProviderRegistryCapability = z.infer<
  typeof ProviderRegistryCapabilitySchema
>;

export const ProviderBaseUrlSupportSchema = z.enum([
  "fixed",
  "configurable",
  "unsupported",
]);
export type ProviderBaseUrlSupport = z.infer<
  typeof ProviderBaseUrlSupportSchema
>;

export const ZeroDataRetentionOptionSchema = z.enum([
  "provider_managed",
  "available",
  "required",
  "unavailable",
  "unknown",
]);
export type ZeroDataRetentionOption = z.infer<
  typeof ZeroDataRetentionOptionSchema
>;

export const ProviderDefinitionSchema = ProviderRegistryEntrySchema.extend({
  capabilities: ProviderRegistryCapabilitySchema,
  baseUrlSupport: ProviderBaseUrlSupportSchema,
  directByokSupport: z.boolean(),
  modelDiscoverySupport: z.boolean(),
  zeroDataRetentionOptions: z.array(ZeroDataRetentionOptionSchema),
});
export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

export const ModelCostClassSchema = z.enum([
  "free",
  "low",
  "standard",
  "premium",
]);
export type ModelCostClass = z.infer<typeof ModelCostClassSchema>;

export const ProviderModelDefinitionSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsReasoningSummary: z.boolean(),
  costClass: ModelCostClassSchema,
  recommendedUse: z.array(z.string().min(1)),
});
export type ProviderModelDefinition = z.infer<
  typeof ProviderModelDefinitionSchema
>;

const VISION_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "opencode-zen",
]);
const REASONING_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "opencode-zen",
]);
const REASONING_SUMMARY_PROVIDERS = new Set(["openai", "openrouter"]);
const DIRECT_BYOK_PROVIDERS = new Set(["openrouter", "groq"]);

export class ProviderRegistry {
  private readonly providersById: ReadonlyMap<string, ProviderDefinition>;
  private readonly modelsByKey: ReadonlyMap<string, ProviderModelDefinition>;

  constructor(
    providers: readonly ProviderDefinition[],
    models: readonly ProviderModelDefinition[],
  ) {
    const parsedProviders = providers.map((provider) =>
      ProviderDefinitionSchema.parse(provider),
    );
    const parsedModels = models.map((model) =>
      ProviderModelDefinitionSchema.parse(model),
    );
    this.providersById = createUniqueMap(
      parsedProviders,
      (provider) => provider.providerId,
      "provider",
    );
    this.modelsByKey = createUniqueMap(
      parsedModels,
      modelKey,
      "provider model",
    );
    this.assertModelsReferenceRegisteredProviders();
  }

  listProviders(): ProviderDefinition[] {
    return Array.from(this.providersById.values());
  }

  listModels(providerId?: string): ProviderModelDefinition[] {
    return Array.from(this.modelsByKey.values()).filter(
      (model) => providerId === undefined || model.providerId === providerId,
    );
  }

  getProvider(providerId: string): ProviderDefinition | undefined {
    return this.providersById.get(providerId);
  }

  getModel(
    providerId: string,
    modelId: string,
  ): ProviderModelDefinition | undefined {
    return this.modelsByKey.get(modelKey({ providerId, modelId }));
  }

  hasProvider(providerId: string): boolean {
    return this.providersById.has(providerId);
  }

  private assertModelsReferenceRegisteredProviders(): void {
    for (const model of this.modelsByKey.values()) {
      if (!this.hasProvider(model.providerId)) {
        throw new Error(
          `Provider model "${modelKey(model)}" references an unregistered provider.`,
        );
      }
    }
  }
}

export const BUILTIN_PROVIDER_DEFINITIONS = Object.freeze([
  ...Object.values(BUILTIN_PROVIDERS).map(toProviderDefinition),
  createLocalOpenAiCompatibleDefinition(),
]);

export const BUILTIN_PROVIDER_MODELS = Object.freeze(
  BUILTIN_PROVIDER_DEFINITIONS.flatMap(toDefaultModelDefinition),
);

export const builtinProviderRegistry = new ProviderRegistry(
  BUILTIN_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_MODELS,
);

function toProviderDefinition(
  entry: ProviderRegistryEntry,
): ProviderDefinition {
  return ProviderDefinitionSchema.parse({
    ...entry,
    capabilities: {
      ...entry.capabilities,
      vision: supportsCapability(entry.providerId, VISION_PROVIDERS),
      reasoning: supportsCapability(entry.providerId, REASONING_PROVIDERS),
      reasoningSummary: supportsCapability(
        entry.providerId,
        REASONING_SUMMARY_PROVIDERS,
      ),
    },
    baseUrlSupport: resolveBaseUrlSupport(entry),
    directByokSupport: DIRECT_BYOK_PROVIDERS.has(entry.providerId),
    modelDiscoverySupport: entry.modelSource === "remote",
    zeroDataRetentionOptions: ["unknown"],
  });
}

function createLocalOpenAiCompatibleDefinition(): ProviderDefinition {
  return ProviderDefinitionSchema.parse({
    providerId: "local-openai-compatible",
    displayName: "Local OpenAI-Compatible Endpoint",
    authModes: ["api_key"],
    launchStage: "hidden",
    capabilities: {
      streaming: true,
      tools: true,
      jsonMode: true,
      structuredOutputs: true,
      vision: false,
      reasoning: false,
      reasoningSummary: false,
    },
    adapterFamily: "openai-compatible",
    modelSource: "remote",
    baseUrlSupport: "configurable",
    directByokSupport: true,
    modelDiscoverySupport: true,
    zeroDataRetentionOptions: ["provider_managed"],
  });
}

function toDefaultModelDefinition(
  provider: ProviderDefinition,
): ProviderModelDefinition[] {
  if (!provider.defaultModelId) {
    return [];
  }
  return [
    ProviderModelDefinitionSchema.parse({
      providerId: provider.providerId,
      modelId: provider.defaultModelId,
      displayName: provider.defaultModelId,
      supportsTools: provider.capabilities.tools,
      supportsVision: provider.capabilities.vision,
      supportsReasoning: provider.capabilities.reasoning,
      supportsReasoningSummary: provider.capabilities.reasoningSummary,
      costClass: provider.providerId === "axis" ? "free" : "standard",
      recommendedUse: ["general"],
    }),
  ];
}

function resolveBaseUrlSupport(
  provider: ProviderRegistryEntry,
): ProviderBaseUrlSupport {
  if (provider.providerId === "local-openai-compatible") {
    return "configurable";
  }
  return provider.baseUrl ? "fixed" : "unsupported";
}

function supportsCapability(
  providerId: string,
  supportedProviders: ReadonlySet<string>,
): boolean {
  return supportedProviders.has(providerId);
}

function modelKey(
  model: Pick<ProviderModelDefinition, "providerId" | "modelId">,
): string {
  return `${model.providerId}:${model.modelId}`;
}

function createUniqueMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  const entries = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (entries.has(key)) {
      throw new Error(`Duplicate ${label} registration: "${key}".`);
    }
    entries.set(key, value);
  }
  return entries;
}
