import { z } from "zod";
import {
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKValidateRequestSchema,
  BYOKValidateResponseSchema,
  ProviderConnectionConfigSchema,
  ModelDescriptorSchema,
} from "../provider.js";
import {
  BYOKDiscoveredProviderModelSchema,
  BYOKDiscoveredProviderModelsMetadataSchema,
  BYOKDiscoveredProviderModelsPageSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKModelDiscoverySourceSchema,
  BYOKModelDiscoverySurfaceSchema,
  BYOKModelDiscoveryViewSchema,
  BYOKModelPopularityScoreSchema,
  BYOKModelPopularitySignalsSchema,
  BYOKModelPricingSchema,
  BYOKProviderSlugSchema,
  BYOKModelCapabilitySchema,
  BYOKModelCapabilityConfidenceSchema,
  BYOKModelCapabilityMetadataSchema,
  BYOKModelCapabilitySourceSchema,
  BYOKModelInputModalitySchema,
  BYOKModelOutputModalitySchema,
  ProviderModelAvailabilitySchema,
  ProviderModelRuntimeRouteSchema,
  ProviderModelTransportSchema,
} from "./model-discovery.js";

/**
 * BYOK API request/response contracts.
 *
 * Canonical source for runtime provider endpoints remains `../provider.ts`.
 * This module also owns credential/preference DTOs used by `/api/byok/*`
 * controller + web client boundaries to avoid app-local drift.
 */
export {
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKValidateRequestSchema,
  BYOKValidateResponseSchema,
};
export type {
  BYOKConnectRequest,
  BYOKConnectResponse,
  BYOKValidateRequest,
  BYOKValidateResponse,
} from "../provider.js";

/**
 * POST /api/byok/credentials
 */
export const BYOKCredentialConnectRequestSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    secret: z.string().min(1).max(4096),
    label: z.string().min(1).max(256).optional(),
    config: ProviderConnectionConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.providerId === "cloudflare-ai" && !value.config) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cloudflare AI requires connection config.",
        path: ["config"],
      });
      return;
    }

    if (value.config && value.config.providerId !== value.providerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Connection config providerId must match providerId.",
        path: ["config", "providerId"],
      });
    }
  });
export type BYOKCredentialConnectRequest = z.infer<
  typeof BYOKCredentialConnectRequestSchema
>;

/**
 * PATCH /api/byok/credentials/:credentialId
 */
export const BYOKCredentialUpdateRequestSchema = z.object({
  label: z.string().min(1).max(256).optional(),
});
export type BYOKCredentialUpdateRequest = z.infer<
  typeof BYOKCredentialUpdateRequestSchema
>;

/**
 * POST /api/byok/credentials/:credentialId/validate
 */
export const BYOKCredentialValidateRequestSchema = z.object({
  mode: z.enum(["format", "live"]).default("format"),
});
export type BYOKCredentialValidateRequest = z.infer<
  typeof BYOKCredentialValidateRequestSchema
>;

export const BYOKCredentialValidateResponseSchema = z.object({
  credentialId: z.string().uuid(),
  valid: z.boolean(),
  validatedAt: z.string().datetime(),
});
export type BYOKCredentialValidateResponse = z.infer<
  typeof BYOKCredentialValidateResponseSchema
>;

/**
 * GET /api/byok/providers/:providerId/models
 */
export const BYOKProviderModelsResponseSchema = z.object({
  providerId: z.string().min(1).max(64),
  models: z.array(ModelDescriptorSchema),
  lastFetchedAt: z.string().datetime(),
});
export type BYOKProviderModelsResponse = z.infer<
  typeof BYOKProviderModelsResponseSchema
>;

/**
 * Dynamic provider model discovery contracts (CP62-1).
 * These schemas freeze the backend-authoritative paginated discovery shape.
 */
export {
  BYOKProviderSlugSchema,
  BYOKModelDiscoveryViewSchema,
  BYOKModelDiscoverySurfaceSchema,
  BYOKModelDiscoverySourceSchema,
  BYOKModelPricingSchema,
  BYOKModelPopularitySignalsSchema,
  BYOKModelPopularityScoreSchema,
  BYOKModelCapabilitySchema,
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
};
export type {
  BYOKProviderSlug,
  BYOKModelDiscoveryView,
  BYOKModelDiscoverySurface,
  BYOKModelDiscoverySource,
  BYOKModelPricing,
  BYOKModelPopularitySignals,
  BYOKModelPopularityScore,
  BYOKModelCapability,
  BYOKModelCapabilityConfidence,
  BYOKModelCapabilityMetadata,
  BYOKModelCapabilitySource,
  BYOKModelInputModality,
  BYOKModelOutputModality,
  ProviderModelTransport,
  ProviderModelAvailability,
  ProviderModelRuntimeRoute,
  BYOKDiscoveredProviderModel,
  BYOKDiscoveredProviderModelsPage,
  BYOKDiscoveredProviderModelsMetadata,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsResponse,
  BYOKDiscoveredProviderModelsRefreshResponse,
} from "./model-discovery.js";

/**
 * PATCH /api/byok/preferences
 */
export const BYOKPreferencesUpdateRequestSchema = z
  .object({
    defaultProviderId: z.string().min(1).max(64).optional(),
    defaultModelId: z.string().min(1).optional(),
    visibleModelIds: z.record(z.string(), z.array(z.string())).optional(),
  })
  .refine(
    (value) =>
      value.defaultProviderId !== undefined ||
      value.defaultModelId !== undefined ||
      value.visibleModelIds !== undefined,
    { message: "At least one preference field is required" },
  );
export type BYOKPreferencesUpdateRequest = z.infer<
  typeof BYOKPreferencesUpdateRequestSchema
>;
