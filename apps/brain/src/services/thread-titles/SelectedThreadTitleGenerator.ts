import { builtinProviderRegistry, normalizeRuntimeModelId, resolveProviderRuntimeRoute } from "@repo/provider-core";
import { parseNativeProviderBindingForAdmission } from "@repo/persistence";
import type { Env } from "../../types/ai";
import type {
  GenerateThreadTitleInput,
  ThreadTitleGenerator,
} from "./ThreadTitleGenerationCoordinator";
import { ThreadTitleOutputSchema } from "./ThreadTitleOutput";
import { resolveThreadTitleProviderOptions } from "@legioncode/app-server/thread-titles";

/** Use the frozen first-request route and existing provider services, never picker defaults. */
export function createSelectedThreadTitleGenerator(
  _env: Env,
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
  const execution = input.nativeExecution;
  if (!execution) throw new Error("Selected Native title generation requires its claimed execution service");
  parseNativeProviderBindingForAdmission(nativeCredentials.binding, execution.scope);
  const service = execution.service;

  return {
    outputFormat: structured ? "json" : "text",
    async generateText(request) {
      assertFixedRoute(request);
      execution.signal.throwIfAborted();
      request.signal?.throwIfAborted();
      const selectedRequest = { ...request, ...fixedRoute };
      // Unknown/reasoning models need room for private reasoning before visible output.
      const providerOptions = resolveThreadTitleProviderOptions(request.maxOutputTokens, capabilities, model?.supportsReasoning);
      const maxTokens = providerOptions.maxOutputTokens;
      if (structured) {
        const structuredRequest = {
          ...selectedRequest, schema: ThreadTitleOutputSchema, maxTokens, abortSignal: request.signal ?? execution.signal,
        };
        const result = await service.generateStructured(structuredRequest);
        return { text: JSON.stringify(result.object), usage: result.usage };
      }
      const textRequest = {
        ...selectedRequest, signal: request.signal ?? execution.signal, maxOutputTokens: maxTokens,
        ...(providerOptions.reasoningEffort ? { reasoningEffort: providerOptions.reasoningEffort } : {}),
      };
      return service.generateText(textRequest);
    },
  };
}
