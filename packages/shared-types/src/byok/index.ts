/**
 * BYOK (Bring Your Own Key) Module
 *
 * Exports for the new BYOK architecture.
 * Decoupled from fixed provider enums, supports dynamic provider registry.
 */

// Credential entity
export {
  BYOKCredentialSchema,
  BYOKCredentialDTOSchema,
  type BYOKCredential,
  type BYOKCredentialDTO,
} from "./credential.js";

// Preference entity
export {
  BYOKPreferenceSchema,
  BYOKPreferencePatchSchema,
  type BYOKPreference,
  type BYOKPreferencePatch,
} from "./preference.js";

// Resolution result
export {
  BYOKResolutionSchema,
  BYOKResolveRequestSchema,
  type BYOKResolution,
  type BYOKResolveRequest,
} from "./resolution.js";

// Error taxonomy
export {
  BYOKErrorCodeSchema,
  BYOKErrorSchema,
  BYOKErrorInternalSchema,
  BYOKErrorEnvelopeSchema,
  BYOKValidationErrorDetailSchema,
  BYOKValidationErrorResponseSchema,
  RETRYABLE_ERRORS,
  isRetryableError,
  AUTH_ERRORS,
  isAuthError,
  createBYOKError,
  createBYOKErrorInternal,
  type BYOKErrorCode,
  type BYOKError,
  type BYOKErrorInternal,
  type BYOKErrorEnvelope,
  type BYOKValidationErrorDetail,
  type BYOKValidationErrorResponse,
} from "./error.js";

// Provider registry
export {
  ProviderAuthModeSchema,
  ProviderAdapterFamilySchema,
  ProviderLaunchStageSchema,
  ProviderValidationAuthModeSchema,
  ProviderRegistryEntrySchema,
  ProviderRegistrySchema,
  BUILTIN_PROVIDERS,
  getBuiltinRegistry,
  findBuiltinProvider,
  isKnownProvider,
  getKnownProviderIds,
  isLaunchVisibleProvider,
  isLaunchSupportedProvider,
  getLaunchVisibleProviders,
  getLaunchSupportedProviders,
  type ProviderAuthMode,
  type ProviderAdapterFamily,
  type ProviderLaunchStage,
  type ProviderValidationAuthMode,
  type ProviderRegistryEntry,
  type ProviderRegistry,
} from "./registry.js";

// API contracts
export {
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKValidateRequestSchema,
  BYOKValidateResponseSchema,
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKCredentialValidateResponseSchema,
  BYOKProviderSlugSchema,
  BYOKModelDiscoveryViewSchema,
  BYOKModelDiscoverySurfaceSchema,
  BYOKModelDiscoverySourceSchema,
  BYOKModelPricingSchema,
  BYOKModelPricingTierSchema,
  BYOKModelPopularitySignalsSchema,
  BYOKModelPopularityScoreSchema,
  BYOKModelCapabilitySchema,
  ReasoningEffortSchema,
  BYOKModelCapabilityConfidenceSchema,
  BYOKModelCapabilityMetadataSchema,
  BYOKModelCapabilitySourceSchema,
  BYOKModelInputModalitySchema,
  BYOKModelOutputModalitySchema,
  ProviderModelTransportSchema,
  ProviderModelAvailabilitySchema,
  ProviderModelRuntimeRouteSchema,
  BYOKDiscoveredProviderModelSchema,
  BYOKDiscoveredProviderModelsPageSchema,
  BYOKDiscoveredProviderModelsMetadataSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKPreferencesUpdateRequestSchema,
  type BYOKConnectRequest,
  type BYOKConnectResponse,
  type BYOKValidateRequest,
  type BYOKValidateResponse,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse,
  type BYOKProviderSlug,
  type BYOKModelDiscoveryView,
  type BYOKModelDiscoverySurface,
  type BYOKModelDiscoverySource,
  type BYOKModelPricing,
  type BYOKModelPricingTier,
  type BYOKModelPopularitySignals,
  type BYOKModelPopularityScore,
  type BYOKModelCapability,
  type ReasoningEffort,
  type BYOKModelCapabilityConfidence,
  type BYOKModelCapabilityMetadata,
  type BYOKModelCapabilitySource,
  type BYOKModelInputModality,
  type BYOKModelOutputModality,
  type ProviderModelTransport,
  type ProviderModelAvailability,
  type ProviderModelRuntimeRoute,
  type BYOKDiscoveredProviderModel,
  type BYOKDiscoveredProviderModelsPage,
  type BYOKDiscoveredProviderModelsMetadata,
  type BYOKDiscoveredProviderModelsQuery,
  type BYOKDiscoveredProviderModelsResponse,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKPreferencesUpdateRequest,
} from "./api.js";

// Product policy
export {
  AXIS_PROVIDER_ID,
  ProviderProductEnvironmentSchema,
  ProviderProductPolicySchema,
  createProviderProductPolicy,
  canShowProviderInPrimaryUi,
  canUseProviderAtRuntime,
  canUseProviderRuntimeFallback,
  canPreloadProvider,
  type ProviderProductEnvironment,
  type ProviderProductPolicy,
} from "./product-policy.js";
