// apps/brain/src/services/providers/adapters/OpenAICompatibleAdapter.ts
// Base adapter for OpenAI-compatible providers (OpenAI, LiteLLM, etc.)

import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import type {
  ProviderAdapter,
  GenerationParams,
  GenerationResult,
  StreamChunk,
} from "../base/ProviderAdapter";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import { normalizeProviderGenerationError } from "./ProviderGenerationError";
import { PROVIDER_SDK_MAX_RETRIES } from "../ProviderRequestPolicy";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel: string;
  supportedModels: string[];
}

export type StreamProducer = ReturnType<typeof streamText>;
export type UsageStandardizer = (
  usage: { promptTokens: number; completionTokens: number },
  model: string,
) => LLMUsage;

export interface StreamHelperOptions {
  streamProducer: StreamProducer;
  model: string;
  params: GenerationParams;
  standardizeUsage: UsageStandardizer;
}

export async function* streamGenerationHelper(
  options: StreamHelperOptions,
): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
  const { streamProducer, model, standardizeUsage } = options;

  let fullText = "";
  let finalUsage: LLMUsage | undefined;
  let finishReason: string | undefined;

  for await (const chunk of streamProducer.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        fullText += chunk.textDelta;
        yield {
          type: "text",
          content: chunk.textDelta,
        };
        break;

      case "tool-call":
        yield {
          type: "tool-call",
          toolCall: {
            toolCallId: readToolCallId(chunk),
            toolName: chunk.toolName,
            args: chunk.args,
          },
        };
        break;

      case "finish":
        finishReason = chunk.finishReason;
        if (chunk.usage) {
          finalUsage = standardizeUsage(chunk.usage, model);
          yield {
            type: "finish",
            usage: finalUsage,
            finishReason: chunk.finishReason,
          };
        }
        break;
    }
  }

  const [finalUsageResult, finalText, finalFinishReason, finalToolCalls] =
    await Promise.all([
      streamProducer.usage,
      streamProducer.text,
      streamProducer.finishReason,
      streamProducer.toolCalls,
    ]);

  if (!finalUsage) {
    finalUsage = standardizeUsage(finalUsageResult, model);
  }

  return {
    content: fullText || finalText,
    usage: finalUsage,
    finishReason: finishReason ?? finalFinishReason,
    toolCalls: finalToolCalls?.map(
      (tc: { toolName: string; args: unknown }) => ({
        toolCallId: readToolCallId(tc),
        toolName: tc.toolName,
        args: tc.args,
      }),
    ),
  };
}

export abstract class OpenAICompatibleAdapter implements ProviderAdapter {
  abstract readonly provider: string;
  abstract readonly supportedModels: string[];

  protected client: OpenAIProvider;
  protected defaultModel: string;

  constructor(config: OpenAICompatibleConfig) {
    this.client = config.baseURL
      ? createOpenAI({
          baseURL: config.baseURL,
          apiKey: config.apiKey,
        })
      : createOpenAI({
          apiKey: config.apiKey,
        });

    this.defaultModel = config.defaultModel;
  }

  supportsModel(model: string): boolean {
    if (this.supportedModels.length === 0) {
      return true;
    }
    return this.supportedModels.includes(model);
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const model = params.model ?? this.defaultModel;

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: this.client(model),
        messages: params.messages,
        system: params.system,
        tools: params.tools,
        temperature: params.temperature,
        abortSignal: params.signal,
        maxRetries: PROVIDER_SDK_MAX_RETRIES,
      });
    } catch (error) {
      throw normalizeProviderGenerationError({
        error,
        providerId: this.provider,
        modelId: model,
      });
    }

    const usage = this.standardizeUsage(result.usage, model);

    return {
      content: result.text,
      usage,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls?.map((tc) => ({
        toolCallId: readToolCallId(tc),
        toolName: tc.toolName,
        args: tc.args,
      })),
    };
  }

  async *generateStream(
    params: GenerationParams,
  ): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
    const model = params.model ?? this.defaultModel;

    const streamResult = streamText({
      model: this.client(model),
      messages: params.messages,
      system: params.system,
      tools: params.tools,
      temperature: params.temperature,
      abortSignal: params.signal,
      maxRetries: PROVIDER_SDK_MAX_RETRIES,
    });

    const standardizeUsageCb = (usage: {
      promptTokens: number;
      completionTokens: number;
    }) => this.standardizeUsage(usage, model);

    let fullText = "";
    let finalUsage: LLMUsage | undefined;
    let finishReason: string | undefined;

    for await (const chunk of streamResult.fullStream) {
      switch (chunk.type) {
        case "text-delta":
          fullText += chunk.textDelta;
          yield {
            type: "text",
            content: chunk.textDelta,
          };
          break;

        case "tool-call":
          yield {
            type: "tool-call",
            toolCall: {
              toolCallId: readToolCallId(chunk),
              toolName: chunk.toolName,
              args: chunk.args,
            },
          };
          break;

        case "finish":
          finishReason = chunk.finishReason;
          if (chunk.usage) {
            finalUsage = standardizeUsageCb(chunk.usage);
            yield {
              type: "finish",
              usage: finalUsage,
              finishReason: chunk.finishReason,
            };
          }
          break;
      }
    }

    const [finalUsageResult, finalText, finalFinishReason, finalToolCalls] =
      await Promise.all([
        streamResult.usage,
        streamResult.text,
        streamResult.finishReason,
        streamResult.toolCalls,
      ]);

    if (!finalUsage) {
      finalUsage = standardizeUsageCb(finalUsageResult);
    }

    return {
      content: fullText || finalText,
      usage: finalUsage,
      finishReason: finishReason ?? finalFinishReason,
      toolCalls: finalToolCalls?.map(
        (tc: { toolName: string; args: unknown }) => ({
          toolCallId: readToolCallId(tc),
          toolName: tc.toolName,
          args: tc.args,
        }),
      ),
    };
  }

  protected abstract standardizeUsage(
    usage: { promptTokens: number; completionTokens: number },
    model: string,
  ): LLMUsage;
}

function readToolCallId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { toolCallId?: unknown; id?: unknown };
  if (typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return record.toolCallId.trim();
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  return undefined;
}
