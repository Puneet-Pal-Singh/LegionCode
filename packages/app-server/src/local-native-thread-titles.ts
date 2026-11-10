import { createProtectedProviderAdapter, type ProtectedProviderInferenceOptions } from "@legioncode/execution-engine/runtime/provider/ProtectedProviderInference";
import { builtinProviderRegistry } from "@repo/provider-core";
import { TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol";
import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import { captureLocalTurnModel } from "./local-turn-model.js";
import { resolveThreadTitleProviderOptions, type ThreadTitleGenerator } from "./thread-titles/index.js";

/** Private metadata inference through the same protected adapter used by Native's gateway. */
export function createLocalNativeThreadTitleGenerator(options: {
  admission: TurnAdmission;
  model: BYOKDiscoveredProviderModel;
  resolveCredential: ProtectedProviderInferenceOptions["resolveCredential"];
}): ThreadTitleGenerator {
  const admission = TurnAdmissionSchema.parse(options.admission);
  const model = captureLocalTurnModel(options.model, {
    providerId: admission.run.providerId, modelId: admission.run.modelId,
  });
  const adapter = createProtectedProviderAdapter({
    providerId: admission.run.providerId, modelId: admission.run.modelId,
    model, resolveCredential: options.resolveCredential,
  });
  const knownModel = builtinProviderRegistry.getModel(admission.run.providerId, admission.run.modelId);
  return {
    outputFormat: "text",
    async generateText(request) {
      if ((request.providerId !== undefined && request.providerId !== admission.run.providerId) ||
          (request.model !== undefined && request.model !== admission.run.modelId))
        throw new Error("Title provider route differs from its first admitted model");
      const result = await adapter.generate({
        messages: request.messages, model: admission.run.modelId,
        temperature: request.temperature, signal: request.signal,
        ...resolveThreadTitleProviderOptions(request.maxOutputTokens, model.capabilities, knownModel?.supportsReasoning),
      });
      return { text: result.content, finishReason: result.finishReason, usage: result.usage };
    },
  };
}
