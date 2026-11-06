import { RunIdSchema, TurnIdSchema } from "@repo/platform-protocol";
import type { ILLMGateway } from "../llm/types.js";
import { normalizeProviderTextResponse } from "../llm/ProviderTextResponse.js";
import { LegacyProviderTranscriptPartNormalizer } from "../llm/TranscriptPartNormalizer.js";
import { ProviderError } from "./base/ProviderAdapter.js";
import {
  createProtectedProviderAdapter,
  type ProtectedProviderInferenceOptions,
} from "./ProtectedProviderInference.js";

/** Trusted runtime bridge; pricing, stepping and lifecycle remain with their existing owners. */
export function createProtectedProviderGateway(
  options: ProtectedProviderInferenceOptions,
): Pick<ILLMGateway, "generateText"> {
  const adapter = createProtectedProviderAdapter(options);
  const normalizer = new LegacyProviderTranscriptPartNormalizer();
  return {
    async generateText(request) {
      const runId = RunIdSchema.safeParse(request.context.runId);
      const turnId = TurnIdSchema.safeParse(request.context.turnId);
      if (
        !runId.success ||
        !turnId.success ||
        (request.providerId !== undefined &&
          request.providerId !== adapter.provider) ||
        (request.runtimeModelId !== undefined &&
          !adapter.supportsModel(request.runtimeModelId))
      ) {
        throw new ProviderError(
          adapter.provider,
          "Native inference requires its explicit run, turn and selected provider",
          undefined,
          {
            code: "INVALID_PROVIDER_CONFIGURATION",
            retryable: false,
          },
        );
      }
      const result = await adapter.generate({
        messages: request.messages,
        system: request.system,
        tools: request.tools,
        model: request.model,
        temperature: request.temperature,
        reasoningEffort: request.reasoningEffort,
        signal: request.signal,
      });
      return normalizeProviderTextResponse({
        result: {
          text: result.content,
          usage: result.usage,
          finishReason: result.finishReason,
          toolCalls: result.toolCalls,
          transcriptParts: result.transcriptParts,
        },
        runId: runId.data,
        turnId: turnId.data,
        providerId: adapter.provider,
        outputIntent:
          request.context.phase === "synthesis" ? "final" : "intermediate",
        normalizer,
      });
    },
  };
}
