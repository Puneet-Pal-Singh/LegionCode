import { z } from "zod";

export const BYOKProviderSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
export type BYOKProviderSlug = z.infer<typeof BYOKProviderSlugSchema>;

export const BYOKModelDiscoveryViewSchema = z.enum(["popular", "all"]);
export type BYOKModelDiscoveryView = z.infer<
  typeof BYOKModelDiscoveryViewSchema
>;

export const BYOKModelDiscoverySurfaceSchema = z.enum(["picker", "manage"]);
export type BYOKModelDiscoverySurface = z.infer<
  typeof BYOKModelDiscoverySurfaceSchema
>;

export const BYOKModelDiscoverySourceSchema = z.enum(["provider_api", "cache"]);
export type BYOKModelDiscoverySource = z.infer<
  typeof BYOKModelDiscoverySourceSchema
>;

export const BYOKModelPricingSchema = z.object({
  inputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
  currency: z.string().min(1).default("USD"),
});
export type BYOKModelPricing = z.infer<typeof BYOKModelPricingSchema>;

export const BYOKModelPopularitySignalsSchema = z.object({
  selectionFrequency: z.number().nonnegative(),
  successfulRuns: z.number().nonnegative(),
  providerDeclared: z.number().nonnegative(),
  capabilityFit: z.number().nonnegative(),
  costEfficiency: z.number().nonnegative(),
});
export type BYOKModelPopularitySignals = z.infer<
  typeof BYOKModelPopularitySignalsSchema
>;

export const BYOKModelPopularityScoreSchema = z.object({
  score: z.number(),
  signals: BYOKModelPopularitySignalsSchema,
});
export type BYOKModelPopularityScore = z.infer<
  typeof BYOKModelPopularityScoreSchema
>;

export const BYOKModelCapabilitySchema = z.object({
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsStructuredOutputs: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
});
export type BYOKModelCapability = z.infer<typeof BYOKModelCapabilitySchema>;

export const BYOKModelOutputModalitySchema = z.object({
  text: z.boolean().optional(),
  image: z.boolean().optional(),
  audio: z.boolean().optional(),
});
export type BYOKModelOutputModality = z.infer<
  typeof BYOKModelOutputModalitySchema
>;

export const ProviderModelTransportSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative",
  "cloudflare-ai-run",
]);
export type ProviderModelTransport = z.infer<
  typeof ProviderModelTransportSchema
>;

export const ProviderModelAvailabilitySchema = z.enum([
  "available",
  "unsupported_transport",
  "limit_exceeded",
]);
export type ProviderModelAvailability = z.infer<
  typeof ProviderModelAvailabilitySchema
>;

export const ProviderModelRuntimeRouteSchema = z.object({
  providerId: BYOKProviderSlugSchema,
  modelId: z.string().min(1),
  transport: ProviderModelTransportSchema,
  endpoint: z.string().url(),
});
export type ProviderModelRuntimeRoute = z.infer<
  typeof ProviderModelRuntimeRouteSchema
>;

export const BYOKDiscoveredProviderModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  providerId: BYOKProviderSlugSchema,
  contextWindow: z.number().int().positive().optional(),
  pricing: BYOKModelPricingSchema.optional(),
  canonicalSlug: z.string().optional(),
  description: z.string().optional(),
  supportedParameters: z.array(z.string()).optional(),
  outputModalities: BYOKModelOutputModalitySchema.optional(),
  capabilities: BYOKModelCapabilitySchema.optional(),
  expirationDate: z.string().datetime().optional(),
  deprecated: z.boolean().optional(),
  popularityScore: BYOKModelPopularityScoreSchema.optional(),
  runtimeRoute: ProviderModelRuntimeRouteSchema.optional(),
  availability: ProviderModelAvailabilitySchema.optional(),
  unavailableReason: z.string().min(1).optional(),
});
export type BYOKDiscoveredProviderModel = z.infer<
  typeof BYOKDiscoveredProviderModelSchema
>;

export const BYOKDiscoveredProviderModelsPageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().min(1).optional(),
  nextCursor: z.string().min(1).optional(),
  hasMore: z.boolean(),
});
export type BYOKDiscoveredProviderModelsPage = z.infer<
  typeof BYOKDiscoveredProviderModelsPageSchema
>;

export const BYOKDiscoveredProviderModelsMetadataSchema = z.object({
  fetchedAt: z.string().datetime(),
  stale: z.boolean(),
  source: BYOKModelDiscoverySourceSchema,
  staleReason: z.string().min(1).optional(),
});
export type BYOKDiscoveredProviderModelsMetadata = z.infer<
  typeof BYOKDiscoveredProviderModelsMetadataSchema
>;

export const BYOKDiscoveredProviderModelsQuerySchema = z.object({
  view: BYOKModelDiscoveryViewSchema.default("popular"),
  surface: BYOKModelDiscoverySurfaceSchema.default("picker"),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type BYOKDiscoveredProviderModelsQuery = z.infer<
  typeof BYOKDiscoveredProviderModelsQuerySchema
>;

export const BYOKDiscoveredProviderModelsResponseSchema = z.object({
  providerId: BYOKProviderSlugSchema,
  view: BYOKModelDiscoveryViewSchema,
  models: z.array(BYOKDiscoveredProviderModelSchema),
  page: BYOKDiscoveredProviderModelsPageSchema,
  metadata: BYOKDiscoveredProviderModelsMetadataSchema,
});
export type BYOKDiscoveredProviderModelsResponse = z.infer<
  typeof BYOKDiscoveredProviderModelsResponseSchema
>;

export const BYOKDiscoveredProviderModelsRefreshResponseSchema = z.object({
  providerId: BYOKProviderSlugSchema,
  refreshedAt: z.string().datetime(),
  source: z.literal("provider_api"),
  cacheInvalidated: z.boolean(),
  modelsCount: z.number().int().nonnegative(),
});
export type BYOKDiscoveredProviderModelsRefreshResponse = z.infer<
  typeof BYOKDiscoveredProviderModelsRefreshResponseSchema
>;
