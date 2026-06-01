/**
 * AI services barrel export
 */

export {
  type ProviderEndpointConfig,
  PROVIDER_ENDPOINTS,
  validateProviderApiKeyFormat,
  getProviderBaseURL,
} from "./ProviderEndpointPolicy";

export {
  type RuntimeProvider,
  type ModelSelection,
  resolveModelSelection,
  mapProviderIdToRuntimeProvider,
  getRuntimeProviderFromAdapter,
} from "./ModelSelectionPolicy";

export {
  resolveOpenAIKey,
  resolveAnthropicKey,
  resolveOpenRouterKey,
  resolveAxisOpenRouterKey,
  resolveGroqKey,
  resolveLiteLLMKey,
  resolveProviderKey,
} from "./ProviderKeyValidator";

export {
  createDefaultAdapter,
  createLiteLLMAdapter,
  createOpenAIAdapter,
  createAnthropicAdapter,
  createGoogleAdapter,
  createOpenRouterAdapter,
  createGroqAdapter,
} from "./ProviderAdapterFactory";

export { getSDKModelConfig, type SDKModelConfig } from "./SDKModelFactory";

export { type GenerateTextResult, generateText } from "./TextGenerationService";

export {
  type GenerateStructuredResult,
  type StructuredGenerationRequest,
  buildStructuredGenerationUsage,
  getStructuredGenerationMode,
  prepareStructuredGenerationRequest,
} from "./StructuredGenerationService";

export { createChatStream } from "./StreamGenerationService";

export { selectAdapter } from "./AdapterSelectionService";

export {
  ProviderModelRouteResolver,
  type ProviderModelRoute,
  type ProviderModelRouteInput,
} from "./ProviderModelRouteResolver";
