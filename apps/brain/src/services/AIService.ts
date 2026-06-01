import { generateObject, type CoreMessage, type CoreTool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ZodSchema } from "zod";
import type { ProviderModelTransport } from "@repo/shared-types";
import type { Env } from "../types/ai";
import type { ProviderAdapter } from "./providers";
import { ProviderConfigService } from "./providers";
import {
  resolveModelSelection,
  mapProviderIdToRuntimeProvider,
  getRuntimeProviderFromAdapter,
  type GenerateTextResult,
  getSDKModelConfig,
  type SDKModelConfig,
  type GenerateStructuredResult,
  buildStructuredGenerationUsage,
  getStructuredGenerationMode,
} from "./ai";
import { resolveSelectionWithPreferences } from "./ai/preference-selection";
import { DefaultAdapterService } from "./ai/DefaultAdapterService";
import { consumeAxisQuotaIfNeeded } from "./ai/axis-quota";
import { AXIS_PROVIDER_ID } from "./providers/axis";
import {
  createChatStreamWithSelection,
  generateTextWithSelection,
} from "./ai/AITextGenerationCoordinator";
import {
  resolveStructuredBaseURLOverride,
  resolveStructuredRuntimeProvider,
} from "./ai/ProviderRouteMetadata";

export class AIService {
  private adapter: ProviderAdapter;
  private defaultModel: string;
  private providerConfigService?: ProviderConfigService;

  constructor(
    private env: Env,
    providerConfigService?: ProviderConfigService,
  ) {
    this.adapter = DefaultAdapterService.createResillient(env);
    this.defaultModel = env.DEFAULT_MODEL ?? "model-unset";
    this.providerConfigService = providerConfigService;
  }

  getProvider(): string {
    return this.adapter.provider;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  resolveModelSelection(
    providerId?: string,
    modelId?: string,
    isByokOverride = false,
  ) {
    const options = isByokOverride ? { isByokOverride } : undefined;
    return resolveModelSelection(
      providerId,
      modelId,
      this.adapter.provider,
      this.defaultModel,
      mapProviderIdToRuntimeProvider,
      getRuntimeProviderFromAdapter,
      options,
    );
  }

  async generateText({
    messages,
    model,
    providerId,
    runtimeModelId,
    providerTransport,
    providerEndpoint,
    temperature = 0.7,
    system,
    tools,
  }: {
    messages: CoreMessage[];
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    system?: string;
    tools?: Record<string, CoreTool>;
  }): Promise<GenerateTextResult> {
    const selection = await resolveSelectionWithPreferences({
      providerId,
      modelId: model,
      providerConfigService: this.providerConfigService,
      resolveSelection: (selectedProviderId, selectedModelId) =>
        this.resolveModelSelection(selectedProviderId, selectedModelId),
    });
    return generateTextWithSelection({
      selection,
      defaultAdapter: this.adapter,
      env: this.env,
      providerConfigService: this.providerConfigService,
      providerId,
      runtimeModelId,
      providerTransport,
      providerEndpoint,
      messages,
      system,
      tools,
      temperature,
    });
  }

  async generateStructured<T>({
    messages,
    schema,
    model,
    providerId,
    runtimeModelId,
    providerTransport,
    providerEndpoint,
    temperature = 0.2,
  }: {
    messages: CoreMessage[];
    schema: ZodSchema<T>;
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
  }): Promise<GenerateStructuredResult<T>> {
    const selection = await resolveSelectionWithPreferences({
      providerId,
      modelId: model,
      providerConfigService: this.providerConfigService,
      resolveSelection: (selectedProviderId, selectedModelId) =>
        this.resolveModelSelection(selectedProviderId, selectedModelId),
    });
    await consumeAxisQuotaIfNeeded(
      selection.providerId,
      this.providerConfigService,
    );

    const overrideApiKey =
      selection.providerId && selection.providerId !== AXIS_PROVIDER_ID
        ? ((await this.providerConfigService?.getApiKey(
            selection.providerId,
          )) ?? undefined)
        : undefined;

    const structuredRuntimeProvider = resolveStructuredRuntimeProvider(
      selection.runtimeProvider,
      providerTransport,
    );
    const structuredBaseURLOverride = resolveStructuredBaseURLOverride(
      providerTransport,
      providerEndpoint,
    );
    const structuredModel = runtimeModelId ?? selection.model;
    const sdkModelConfig = getSDKModelConfig(
      structuredModel,
      structuredRuntimeProvider,
      this.env,
      overrideApiKey,
      selection.providerId,
      structuredBaseURLOverride,
    );

    const sdkModel = this.createSDKModel(sdkModelConfig);

    const result = await generateObject({
      model: sdkModel,
      messages,
      schema,
      temperature,
      mode: getStructuredGenerationMode(selection.runtimeProvider),
    });

    return {
      object: result.object,
      usage: buildStructuredGenerationUsage({
        provider: selection.runtimeProvider,
        providerId: selection.providerId,
        baseURL: sdkModelConfig.baseURL,
        model: structuredModel,
        usage: result.usage,
      }),
    };
  }

  async createChatStream({
    messages,
    system,
    tools,
    model,
    providerId,
    runtimeModelId,
    providerTransport,
    providerEndpoint,
    temperature = 0.7,
    onFinish,
    onChunk,
  }: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, CoreTool>;
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    onFinish?: (result: GenerateTextResult) => Promise<void> | void;
    onChunk?: (chunk: {
      content?: string;
      toolCall?: { toolName: string; args: unknown };
    }) => void;
  }): Promise<ReadableStream<Uint8Array>> {
    const selection = await resolveSelectionWithPreferences({
      providerId,
      modelId: model,
      providerConfigService: this.providerConfigService,
      resolveSelection: (selectedProviderId, selectedModelId) =>
        this.resolveModelSelection(selectedProviderId, selectedModelId),
    });
    return createChatStreamWithSelection({
      selection,
      defaultAdapter: this.adapter,
      env: this.env,
      providerConfigService: this.providerConfigService,
      providerId,
      runtimeModelId,
      providerTransport,
      providerEndpoint,
      messages,
      system,
      tools,
      temperature,
      onFinish,
      onChunk,
    });
  }

  getProviderAdapter(): ProviderAdapter {
    return this.adapter;
  }

  private createSDKModel(config: SDKModelConfig) {
    const { provider, apiKey, baseURL, model } = config;

    if (provider === "anthropic-native") {
      const client = createAnthropic({
        apiKey,
        baseURL,
      });
      return client(model);
    }

    if (provider === "google-native") {
      const client = createGoogleGenerativeAI({
        apiKey,
        baseURL,
      });
      return client(model);
    }

    const client = createOpenAI({
      baseURL,
      apiKey,
    });

    return client(model);
  }
}
