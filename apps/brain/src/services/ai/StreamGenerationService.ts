/**
 * StreamGenerationService - Streaming text generation
 *
 * Single Responsibility: Create streaming chat responses with callbacks.
 * Handles accumulation and event delegation.
 */

import type { CoreMessage, CoreTool } from "ai";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import type { ProviderAdapter, GenerationParams } from "../providers";
import type { GenerateTextResult } from "./TextGenerationService";

/**
 * Create a streaming chat response from a provider adapter.
 *
 * @param adapter - The provider adapter to use
 * @param params - Generation parameters
 * @param callbacks - Optional callbacks for chunks and finish events
 * @returns ReadableStream<Uint8Array> for streaming responses
 */
export function createChatStream(
  adapter: ProviderAdapter,
  params: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, CoreTool>;
    temperature?: number;
    model: string;
  },
  callbacks?: {
    onFinish?: (result: GenerateTextResult) => Promise<void> | void;
    onChunk?: (chunk: {
      content?: string;
      toolCall?: { toolCallId?: string; toolName: string; args: unknown };
    }) => void;
  },
): ReadableStream<Uint8Array> {
  const generationParams: GenerationParams = {
    messages: params.messages,
    system: params.system,
    tools: params.tools,
    temperature: params.temperature,
    model: params.model,
  };

  const encoder = new TextEncoder();
  let accumulatedText = "";
  let finalUsage: LLMUsage | undefined;
  let finalFinishReason: string | undefined;
  const toolCalls: NonNullable<GenerateTextResult["toolCalls"]> = [];

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        const generator = adapter.generateStream(generationParams);

        for await (const chunk of generator) {
          switch (chunk.type) {
            case "text":
              if (chunk.content) {
                accumulatedText += chunk.content;
                controller.enqueue(encoder.encode(chunk.content));
                if (callbacks?.onChunk) {
                  callbacks.onChunk({ content: chunk.content });
                }
              }
              break;

            case "tool-call":
              if (callbacks?.onChunk && chunk.toolCall) {
                callbacks.onChunk({ toolCall: chunk.toolCall });
              }
              if (chunk.toolCall) {
                toolCalls.push(chunk.toolCall);
              }
              break;

            case "finish":
              finalUsage = chunk.usage;
              finalFinishReason = chunk.finishReason;
              break;
          }
        }

        const finalResult: GenerateTextResult = {
          text: accumulatedText,
          usage: finalUsage ?? {
            provider: adapter.provider,
            model: params.model,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
          finishReason: finalFinishReason,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        if (callbacks?.onFinish) {
          await callbacks.onFinish(finalResult);
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
