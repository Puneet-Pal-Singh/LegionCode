import { builtinProviderRegistry } from "@repo/provider-core";
import { AIService } from "../AIService";
import { createPostgresProviderConfigService } from "../providers/stores/PostgresStoreFactory";
import type { Env } from "../../types/ai";
import type {
  GenerateThreadTitleInput,
  ThreadTitleGenerator,
} from "./ThreadTitleGenerationCoordinator";
import { ThreadTitleOutputSchema } from "./ThreadTitleOutput";

/** Use the frozen first-request route and existing provider services, never picker defaults. */
export function createSelectedThreadTitleGenerator(
  env: Env,
  input: GenerateThreadTitleInput,
): ThreadTitleGenerator {
  const provider = input.providerId
    ? builtinProviderRegistry.getProvider(input.providerId)
    : undefined;
  const model =
    input.providerId && input.modelId
      ? builtinProviderRegistry.getModel(input.providerId, input.modelId)
      : undefined;
  const capabilities = input.modelCapabilities;
  const structured =
    capabilities?.supportsStructuredOutputs === true &&
    provider?.capabilities.structuredOutputs === true &&
    // AIService's structured path currently wires explicit routes only for chat completions.
    (!input.providerTransport ||
      input.providerTransport === "openai-chat-completions") &&
    (provider.capabilities.jsonMode ||
      provider.adapterFamily === "anthropic-native" ||
      provider.adapterFamily === "google-native");
  const reasoning = capabilities?.supportsReasoning ?? model?.supportsReasoning;
  const service = new AIService(
    env,
    createPostgresProviderConfigService(
      env,
      input.userId,
      input.workspaceId,
      input.runId,
    ),
  );

  return {
    outputFormat: structured ? "json" : "text",
    async generateText(request) {
      // Unknown/reasoning models need room for private reasoning before visible output.
      const maxTokens = reasoning === false ? request.maxOutputTokens : 2048;
      if (structured) {
        const result = await service.generateStructured({
          ...request,
          schema: ThreadTitleOutputSchema,
          maxTokens,
          abortSignal: request.signal,
        });
        return { text: JSON.stringify(result.object), usage: result.usage };
      }
      return service.generateText({
        ...request,
        maxOutputTokens: maxTokens,
        ...(capabilities?.reasoningEfforts?.includes("low")
          ? { reasoningEffort: "low" }
          : {}),
      });
    },
  };
}
