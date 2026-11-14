import { generateObject, type CoreMessage, type CoreTool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type {
  ProviderModelTransport,
  ReasoningEffort,
} from "@repo/shared-types";
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
import { resolveNativeProviderSelection, resolveSelectionWithPreferences } from "./ai/preference-selection";
import { createNativeStructuredModelConfiguration } from "./ai/NativeStructuredModelConfiguration";
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
import type { StructuredGenerationInput } from "./ai/StructuredGenerationInput";
import type { ChatStreamInput } from "./ai/ChatStreamInput";
import { PROVIDER_SDK_MAX_RETRIES } from "@legioncode/execution-engine/runtime/provider/ProviderRequestPolicy";
import { createStructuredProviderInferenceAdapter } from "@legioncode/execution-engine/runtime/provider/ProviderInferenceFactory";

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
    return this.providerConfigService?.getNativeProviderSelection?.()?.providerId ?? this.adapter.provider;
  }
  getDefaultModel(): string {
    return this.providerConfigService?.getNativeProviderSelection?.()?.modelId ?? this.defaultModel;
  }

  resolveModelSelection(
    providerId?: string,
    modelId?: string,
    isByokOverride = false,
  ) {
    const native = resolveNativeProviderSelection(this.providerConfigService, providerId, modelId);
    const options = isByokOverride ? { isByokOverride } : undefined;
    return resolveModelSelection(
      native?.providerId ?? providerId,
      native?.modelId ?? modelId,
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
    maxOutputTokens,
    reasoningEffort,
    system,
    tools,
    signal,
  }: {
    messages: CoreMessage[];
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort;
    system?: string;
    tools?: Record<string, CoreTool>;
    signal?: AbortSignal;
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
      maxOutputTokens,
      reasoningEffort,
      signal,
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
    maxTokens,
    abortSignal,
  }: StructuredGenerationInput<T>): Promise<GenerateStructuredResult<T>> {
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

    const nativeStructured = Boolean(this.providerConfigService?.getNativeProviderSelection?.());
    let sdkModelConfig: SDKModelConfig;
    if (nativeStructured && this.providerConfigService) {
      const native = await createNativeStructuredModelConfiguration({
        credentials: this.providerConfigService, selection, runtimeModelId, providerTransport, providerEndpoint,
      });
      if (native.kind === "responses") {
        return createStructuredProviderInferenceAdapter(native.config).generate({
          messages, schema, model: native.model, temperature,
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
      }
      sdkModelConfig = native.config;
    } else {
      const overrideApiKey =
        selection.providerId && selection.providerId !== AXIS_PROVIDER_ID
          ? ((await this.providerConfigService?.getApiKey(selection.providerId)) ?? undefined)
          : undefined;
      const structuredRuntimeProvider = resolveStructuredRuntimeProvider(selection.runtimeProvider, providerTransport);
      const structuredBaseURLOverride = resolveStructuredBaseURLOverride(providerTransport, providerEndpoint);
      sdkModelConfig = getSDKModelConfig(
        runtimeModelId ?? selection.model, structuredRuntimeProvider, this.env,
        overrideApiKey, selection.providerId, structuredBaseURLOverride,
      );
    }

    const sdkModel = this.createSDKModel(sdkModelConfig);

    const result = await generateObject({
      model: sdkModel,
      messages,
      schema,
      temperature,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      mode: getStructuredGenerationMode(nativeStructured ? sdkModelConfig.provider : selection.runtimeProvider),
      maxRetries: PROVIDER_SDK_MAX_RETRIES,
    });

    return {
      object: result.object,
      usage: buildStructuredGenerationUsage({
        provider: nativeStructured ? sdkModelConfig.provider : selection.runtimeProvider,
        providerId: selection.providerId,
        baseURL: sdkModelConfig.baseURL,
        model: sdkModelConfig.model,
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
    reasoningEffort,
    onFinish,
    onChunk,
  }: ChatStreamInput): Promise<ReadableStream<Uint8Array>> {
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
      reasoningEffort,
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
