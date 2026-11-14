import { builtinProviderRegistry, normalizeRuntimeModelId, resolveProviderRuntimeRoute } from "@repo/provider-core";
import { parseNativeProviderBindingForAdmission } from "@repo/persistence";
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
  const nativeCredentials = input.nativeProviderCredentials;
  if (!nativeCredentials) throw new Error("Selected Native title generation requires its original admission");
  const binding = parseNativeProviderBindingForAdmission(nativeCredentials.binding, { ...nativeCredentials.scope,
    userId: input.userId, workspaceId: input.workspaceId, sessionId: input.sessionId, threadId: input.threadId, runId: input.runId });
  if (input.providerId !== binding.providerId || input.modelId !== binding.modelId) {
    throw new Error("Selected Native title generation must retain its admitted provider and model");
  }
  const fixedRoute = resolveProviderRuntimeRoute(binding.providerId, binding.modelId);
  const assertFixedRoute = (candidate: Pick<GenerateThreadTitleInput, "providerTransport" | "providerEndpoint" | "runtimeModelId">) => {
    if (fixedRoute &&
        ((candidate.providerTransport !== undefined && candidate.providerTransport !== fixedRoute.providerTransport) ||
         (candidate.providerEndpoint !== undefined && candidate.providerEndpoint !== fixedRoute.providerEndpoint) ||
         (candidate.runtimeModelId !== undefined && normalizeRuntimeModelId(binding.providerId, candidate.runtimeModelId) !== fixedRoute.runtimeModelId))) {
      throw new Error("Selected Native title generation must retain its canonical provider route");
    }
  };
  assertFixedRoute(input);
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
    (!input.providerTransport ||
      input.providerTransport === "openai-chat-completions" ||
      (input.providerTransport === "openai-responses" && fixedRoute?.providerTransport === "openai-responses")) &&
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
      nativeCredentials,
    ),
  );

  return {
    outputFormat: structured ? "json" : "text",
    async generateText(request) {
      assertFixedRoute(request);
      const selectedRequest = { ...request, ...fixedRoute };
      // Unknown/reasoning models need room for private reasoning before visible output.
      const maxTokens = reasoning === false ? request.maxOutputTokens : 2048;
      if (structured) {
        const result = await service.generateStructured({
          ...selectedRequest,
          schema: ThreadTitleOutputSchema,
          maxTokens,
          abortSignal: request.signal,
        });
        return { text: JSON.stringify(result.object), usage: result.usage };
      }
      return service.generateText({
        ...selectedRequest,
        maxOutputTokens: maxTokens,
        ...(capabilities?.reasoningEfforts?.includes("low")
          ? { reasoningEffort: "low" }
          : {}),
      });
    },
  };
}
