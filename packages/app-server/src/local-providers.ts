import {
  ProviderIdSchema,
} from "@repo/platform-protocol";
import {
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelSchema,
  getBuiltinRegistry,
  type BYOKDiscoveredProviderModelsResponse,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import {
  builtinProviderRegistry,
} from "@repo/provider-core";
import { z } from "zod";

const ProviderSelectionSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1).max(256).refine((value) => value.trim() === value),
}).strict();

export const ProviderConfigurationSchema = z.object({
  providerId: ProviderIdSchema,
  status: z.literal("present"),
}).strict();
export type ProviderConfiguration = z.infer<typeof ProviderConfigurationSchema>;

export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;

export interface LocalProviderServiceOptions {
  readonly selectionStore: {
    read(): Promise<ProviderSelection | null>;
    write(selection: ProviderSelection): Promise<void>;
    clear(): Promise<void>;
  };
}

/** Provider catalog and the secret-free local provider selection. */
export class LocalProviderService {
  constructor(private readonly options: LocalProviderServiceOptions) {}

  listCatalog(): ProviderRegistryEntry[] {
    return getBuiltinRegistry().providers.filter(isSupportedApiKeyProvider);
  }

  listModels(providerIdInput: string): BYOKDiscoveredProviderModelsResponse {
    const providerId = ProviderIdSchema.parse(providerIdInput);
    const provider = getBuiltinRegistry().providers.find((entry) => entry.providerId === providerId);
    if (!provider || !isSupportedApiKeyProvider(provider)) throw new Error("Provider is unavailable");
    const models = builtinProviderRegistry.listModels(providerId)
      .map((model) => {
        return BYOKDiscoveredProviderModelSchema.parse({
          id: model.modelId,
          name: model.displayName,
          providerId,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          capabilities: {
            supportsTools: model.supportsTools,
            supportsVision: model.supportsVision,
            supportsReasoning: model.supportsReasoning,
          },
        });
      });
    return BYOKDiscoveredProviderModelsResponseSchema.parse({
      providerId,
      view: "popular",
      models,
      page: { limit: Math.max(1, models.length), hasMore: false },
      metadata: {
        fetchedAt: new Date().toISOString(),
        stale: false,
        source: "registry",
        status: "available",
      },
    });
  }

  async getSelection(): Promise<ProviderSelection | null> {
    const selection = await this.options.selectionStore.read();
    if (selection === null) return null;
    return ProviderSelectionSchema.parse(selection);
  }

  async select(
    input: unknown,
    configuration: unknown,
  ): Promise<ProviderSelection> {
    const selection = ProviderSelectionSchema.parse(input);
    const trustedConfiguration = ProviderConfigurationSchema.parse(configuration);
    if (trustedConfiguration.providerId !== selection.providerId) {
      throw new Error("Provider credential configuration does not match selection");
    }
    const provider = getBuiltinRegistry().providers.find((entry) => entry.providerId === selection.providerId);
    if (!provider || !isSupportedApiKeyProvider(provider)) {
      throw new Error("Provider is unavailable");
    }
    if (!builtinProviderRegistry.getModel(selection.providerId, selection.modelId)) {
      throw new Error("Provider model is unavailable");
    }
    await this.options.selectionStore.write(selection);
    return selection;
  }

  async clearSelection(): Promise<void> {
    await this.options.selectionStore.clear();
  }
}

function isSupportedApiKeyProvider(provider: ProviderRegistryEntry): boolean {
  return provider.launchStage === "supported" && provider.authModes.includes("api_key");
}
