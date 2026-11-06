/**
 * Provider services barrel export
 */

// Core services
export { ProviderCredentialService } from "./ProviderCredentialService";
export { CloudCredentialVault } from "./CloudCredentialVault";
export { DesktopCredentialVaultStub } from "./DesktopCredentialVaultStub";
export { ProviderCatalogService } from "./ProviderCatalogService";
export { ProviderConnectionService } from "./ProviderConnectionService";
export { ProviderConfigService } from "./ProviderConfigService";
export { ProviderRegistryService } from "./ProviderRegistryService";
export { ProviderRateLimitService } from "./ProviderRateLimitService";
export { ProviderLiveValidationService } from "./ProviderLiveValidationService";

export {
  AXIS_PROVIDER_ID,
  AXIS_DAILY_LIMIT,
  AXIS_CURATED_MODEL_IDS,
  getAxisCatalogModels,
  getAxisDiscoveredModels,
} from "./axis";
export {
  ProviderModelDiscoveryAuthError,
  ProviderModelDiscoveryApiError,
  ProviderModelNormalizationError,
  ProviderModelCacheError,
  ProviderModelDiscoveryService,
  OpenRouterModelCatalogAdapter,
  GoogleModelCatalogAdapter,
  OpenAICompatibleModelCatalogAdapter,
  ProviderModelRankingService,
  type ProviderModelCatalogPort,
  type ProviderModelCachePort,
  type ProviderModelRankingPort,
  type ProviderModelCredentialContext,
  type ProviderModelFetchPageInput,
  type ProviderModelPageFetchResult,
  type ProviderModelCacheGetInput,
  type ProviderModelCacheSetInput,
  type ProviderModelCacheEntry,
  type ProviderModelRankingSignals,
  type ProviderModelRankingInput,
  type ProviderModelRankingResult,
} from "./model-discovery";
export {
  PROVIDER_CAPABILITY_MATRIX,
  isModelAllowedByCapabilityMatrix,
  getProviderCapabilityFlags,
} from "./provider-capability-matrix";
export type { IProviderConfigService } from "./IProviderConfigService";

// Base types and errors
export {
  ProviderError,
  type ProviderAdapter,
  type GenerationParams,
  type GenerationResult,
  type StreamChunk,
} from "@legioncode/execution-engine/runtime/provider/base/index";

// Encryption configuration
export { readByokEncryptionConfig } from "./provider-encryption-key";

// Adapter implementations
export { LiteLLMAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/index";
export { OpenAIAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/index";
export { AnthropicAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/index";
export { AnthropicMessagesAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/index";
export { GoogleAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/index";
export { OpenAIResponsesAdapter } from "@legioncode/execution-engine/runtime/provider/adapters/index";
export {
  OpenAICompatibleAdapter,
  streamGenerationHelper,
  type OpenAICompatibleConfig,
  type StreamHelperOptions,
  type StreamProducer,
  type UsageStandardizer,
} from "@legioncode/execution-engine/runtime/provider/adapters/index";
