import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText } from "ai";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import type {
  GenerationParams,
  GenerationResult,
  ProviderAdapter,
  StreamChunk,
} from "../base/ProviderAdapter";
import { ProviderError } from "../base/ProviderAdapter";

interface AnthropicMessagesConfig {
  apiKey: string;
  endpoint: string;
  providerId: string;
  defaultModel?: string;
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly supportedModels: string[] = [];
  readonly provider: string;
  private readonly client: ReturnType<typeof createAnthropic>;
  private readonly defaultModel?: string;

  constructor(config: AnthropicMessagesConfig) {
    this.provider = config.providerId;
    this.defaultModel = config.defaultModel;
    this.client = createAnthropic({
      apiKey: config.apiKey,
      baseURL: toAnthropicBaseURL(config.endpoint),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  }

  supportsModel(_model: string): boolean {
    return true;
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const model = this.resolveModel(params.model);
    const result = await generateText({
      model: this.client(model),
      messages: params.messages,
      system: params.system,
      tools: params.tools,
      temperature: params.temperature,
    });

    return {
      content: result.text,
      usage: this.standardizeUsage(result.usage, model),
      finishReason: result.finishReason,
      toolCalls: result.toolCalls?.map((toolCall) => ({
        toolName: toolCall.toolName,
        args: toolCall.args,
      })),
    };
  }

  async *generateStream(
    params: GenerationParams,
  ): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
    const model = this.resolveModel(params.model);
    const streamResult = streamText({
      model: this.client(model),
      messages: params.messages,
      system: params.system,
      tools: params.tools,
      temperature: params.temperature,
    });

    let fullText = "";
    let finalUsage: LLMUsage | undefined;
    let finishReason: string | undefined;

    for await (const chunk of streamResult.fullStream) {
      if (chunk.type === "text-delta") {
        fullText += chunk.textDelta;
        yield { type: "text", content: chunk.textDelta };
      }
      if (chunk.type === "tool-call") {
        yield {
          type: "tool-call",
          toolCall: {
            toolName: chunk.toolName,
            args: chunk.args,
          },
        };
      }
      if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
        if (chunk.usage) {
          finalUsage = this.standardizeUsage(chunk.usage, model);
          yield {
            type: "finish",
            usage: finalUsage,
            finishReason: chunk.finishReason,
          };
        }
      }
    }

    const [usage, text, resolvedFinishReason, toolCalls] = await Promise.all([
      streamResult.usage,
      streamResult.text,
      streamResult.finishReason,
      streamResult.toolCalls,
    ]);

    return {
      content: fullText || text,
      usage: finalUsage ?? this.standardizeUsage(usage, model),
      finishReason: finishReason ?? resolvedFinishReason,
      toolCalls: toolCalls?.map((toolCall) => ({
        toolName: toolCall.toolName,
        args: toolCall.args,
      })),
    };
  }

  private resolveModel(model: string | undefined): string {
    const resolvedModel = model ?? this.defaultModel;
    if (!resolvedModel) {
      throw new ProviderError(
        this.provider,
        "Model is required for Anthropic Messages transport.",
      );
    }
    return resolvedModel;
  }

  private standardizeUsage(
    usage: { promptTokens: number; completionTokens: number },
    model: string,
  ): LLMUsage {
    return {
      provider: this.provider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      raw: usage,
    };
  }
}

function toAnthropicBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  return trimmed.endsWith("/messages")
    ? trimmed.slice(0, -"/messages".length)
    : trimmed;
}
