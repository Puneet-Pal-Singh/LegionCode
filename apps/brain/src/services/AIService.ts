import { generateObject, type CoreMessage, type CoreTool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ZodSchema } from "zod";
import type { ProviderModelTransport } from "@repo/shared-types";
import type { Env } from "../types/ai";
import type {
  ProviderAdapter,
  GenerationParams,
  GenerationResult,
  StreamChunk,
} from "./providers";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import { ProviderConfigService } from "./providers";
import { ValidationError } from "../domain/errors";
import {
  createDefaultAdapter,
  resolveModelSelection,
  mapProviderIdToRuntimeProvider,
  getRuntimeProviderFromAdapter,
  selectAdapter,
  generateText,
  type GenerateTextResult,
  createChatStream,
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
import { normalizeFinishCallback } from "./ai/normalize-finish-callback";

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
    await consumeAxisQuotaIfNeeded(
      selection.providerId,
      this.providerConfigService,
    );
    const selectedAdapter = await selectAdapter(
      selection,
      this.adapter,
      this.env,
      this.providerConfigService,
      undefined,
      buildProviderTransportRoute({
        providerId: selection.providerId,
        providerTransport,
        providerEndpoint,
      }),
    );
    const result = await generateText(selectedAdapter, {
      messages,
      system,
      tools,
      temperature,
      model: runtimeModelId ?? selection.model,
    });

    if (providerId && result.usage.provider !== providerId) {
      return {
        ...result,
        usage: {
          ...result.usage,
          provider: providerId,
        },
      };
    }

    return result;
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
    const sdkModelConfig = getSDKModelConfig(
      runtimeModelId ?? selection.model,
      structuredRuntimeProvider,
      this.env,
      overrideApiKey,
      selection.providerId,
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
        model: selection.model,
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
    await consumeAxisQuotaIfNeeded(
      selection.providerId,
      this.providerConfigService,
    );
    const selectedAdapter = await selectAdapter(
      selection,
      this.adapter,
      this.env,
      this.providerConfigService,
      undefined,
      buildProviderTransportRoute({
        providerId: selection.providerId,
        providerTransport,
        providerEndpoint,
      }),
    );

    const normalizedOnFinish = normalizeFinishCallback(providerId, onFinish);

    return createChatStream(
      selectedAdapter,
      {
        messages,
        system,
        tools,
        temperature,
        model: runtimeModelId ?? selection.model,
      },
      {
        onFinish: normalizedOnFinish,
        onChunk,
      },
    );
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

function buildProviderTransportRoute(input: {
  providerId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
}) {
  if (
    !input.providerId ||
    !input.providerTransport ||
    !input.providerEndpoint
  ) {
    return undefined;
  }
  return {
    providerId: input.providerId,
    transport: input.providerTransport,
    endpoint: input.providerEndpoint,
  };
}

function resolveStructuredRuntimeProvider(
  runtimeProvider: SDKModelConfig["provider"],
  providerTransport: ProviderModelTransport | undefined,
): SDKModelConfig["provider"] {
  if (!providerTransport) {
    return runtimeProvider;
  }
  if (providerTransport === "openai-chat-completions") {
    return "openai-compatible";
  }
  throw new ValidationError(
    `Structured generation is not wired for provider transport "${providerTransport}".`,
    "UNKNOWN_PROVIDER",
  );
}

export type { GenerateTextResult };
