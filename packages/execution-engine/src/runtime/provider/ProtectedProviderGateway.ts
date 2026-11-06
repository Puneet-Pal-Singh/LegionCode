import { RunIdSchema, TurnIdSchema } from "@repo/platform-protocol";
import { ProviderIdSchema } from "@repo/shared-types";
import type { ILLMGateway } from "../llm/types.js";
import { normalizeProviderTextResponse } from "../llm/ProviderTextResponse.js";
import { LegacyProviderTranscriptPartNormalizer } from "../llm/TranscriptPartNormalizer.js";
import { ProviderError } from "./base/ProviderAdapter.js";
import {
  createProtectedProviderAdapter,
  type ProtectedProviderInferenceOptions,
} from "./ProtectedProviderInference.js";

export type ProtectedProviderGatewayOptions = Omit<
  ProtectedProviderInferenceOptions,
  "providerId"
> & { readonly providerId: string };

/** Trusted runtime bridge; pricing, stepping and lifecycle remain with their existing owners. */
export function createProtectedProviderGateway(
  options: ProtectedProviderGatewayOptions,
): Pick<ILLMGateway, "generateText"> {
  const providerId = ProviderIdSchema.safeParse(options.providerId);
  if (!providerId.success) {
    throw new ProviderError(
      "native",
      "Selected provider is unavailable",
      undefined,
      {
        code: "INVALID_PROVIDER_CONFIGURATION",
        retryable: false,
      },
    );
  }
  const adapter = createProtectedProviderAdapter({
    ...options,
    providerId: providerId.data,
  });
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
