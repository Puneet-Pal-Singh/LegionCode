import {
  ProviderIdSchema,
  type ProviderId,
} from "@repo/platform-protocol";
import {
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  getBuiltinRegistry,
  type BYOKDiscoveredProviderModel,
  type BYOKDiscoveredProviderModelsQuery,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKDiscoveredProviderModelsResponse,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { z } from "zod";
import { withLocalProviderModelRoute } from "./local-provider-model-route.js";
import {
  modelCatalogUnavailable,
  readLocalProviderModelInventory,
  type LocalProviderModelCatalog,
} from "./local-provider-model-catalog.js";

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
  readonly modelCatalog?: LocalProviderModelCatalog;
  readonly selectionStore: {
    read(): Promise<ProviderSelection | null>;
    write(selection: ProviderSelection): Promise<void>;
    clear(): Promise<void>;
  };
}

/** Provider catalog and the secret-free local provider selection. */
export class LocalProviderService {
  private readonly modelLookups = new Map<ProviderId, Promise<ReadonlyMap<string, BYOKDiscoveredProviderModel>>>();
  constructor(private readonly options: LocalProviderServiceOptions) {}

  listCatalog(): ProviderRegistryEntry[] {
    return getBuiltinRegistry().providers.filter(isSupportedApiKeyProvider);
  }

  async listModels(
    providerIdInput: string,
    inputQuery?: BYOKDiscoveredProviderModelsQuery,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    const providerId = this.requireProvider(providerIdInput);
    const query = BYOKDiscoveredProviderModelsQuerySchema.parse(inputQuery ?? {});
    const response = BYOKDiscoveredProviderModelsResponseSchema.parse(
      await this.requireModelCatalog().getDiscoveredModels(providerId, query),
    );
    if (response.providerId !== providerId || response.view !== query.view ||
        response.models.some((model) => model.providerId !== providerId))
      throw modelCatalogUnavailable("Provider model discovery identity did not match its request.");
    return { ...response, models: response.models.map(withLocalProviderModelRoute) };
  }

  async refreshProviderModels(providerIdInput: string): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    const providerId = this.requireProvider(providerIdInput);
    const response = BYOKDiscoveredProviderModelsRefreshResponseSchema.parse(
      await this.requireModelCatalog().refreshDiscoveredModels(providerId),
    );
    if (response.providerId !== providerId)
      throw modelCatalogUnavailable("Provider model refresh identity did not match its request.");
    return response;
  }

  async getModel(providerIdInput: ProviderId, modelIdInput: string): Promise<BYOKDiscoveredProviderModel | null> {
    const providerId = this.requireProvider(providerIdInput);
    const modelId = ProviderSelectionSchema.shape.modelId.parse(modelIdInput);
    let request = this.modelLookups.get(providerId);
    if (!request) {
      request = readLocalProviderModelInventory(providerId, (query) => this.listModels(providerId, query));
      this.modelLookups.set(providerId, request);
    }
    try {
      return (await request).get(modelId) ?? null;
    } finally {
      if (this.modelLookups.get(providerId) === request) this.modelLookups.delete(providerId);
    }
  }

  async getSelection(): Promise<ProviderSelection | null> {
    const stored = await this.options.selectionStore.read();
    if (stored === null) return null;
    // Saved selection is user intent. Model availability is checked when a new
    // selection is saved and again at admission, so setup remains recoverable.
    const selection = ProviderSelectionSchema.parse(stored);
    this.requireProvider(selection.providerId);
    return selection;
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
    await this.validateSelection(selection);
    await this.options.selectionStore.write(selection);
    return selection;
  }

  private async validateSelection(input: unknown): Promise<ProviderSelection> {
    const selection = ProviderSelectionSchema.parse(input);
    const model = await this.getModel(selection.providerId, selection.modelId);
    if (!model || (model.availability !== undefined && model.availability !== "available")) {
      throw new Error("Provider model is unavailable");
    }
    return selection;
  }

  private requireProvider(input: string): ProviderId {
    const providerId = ProviderIdSchema.parse(input);
    const provider = getBuiltinRegistry().providers.find((entry) => entry.providerId === providerId);
    if (!provider || !isSupportedApiKeyProvider(provider)) throw new Error("Provider is unavailable");
    return providerId;
  }

  private requireModelCatalog(): LocalProviderModelCatalog {
    if (!this.options.modelCatalog)
      throw modelCatalogUnavailable("Local provider model discovery is not configured.");
    return this.options.modelCatalog;
  }

  async clearSelection(): Promise<void> {
    await this.options.selectionStore.clear();
  }
}

function isSupportedApiKeyProvider(provider: ProviderRegistryEntry): boolean {
  return provider.launchStage === "supported" && provider.authModes.includes("api_key");
}
