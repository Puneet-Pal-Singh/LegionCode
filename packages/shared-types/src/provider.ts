import { z } from "zod";

export const PROVIDER_ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const PROVIDER_ID_REGEX = new RegExp(PROVIDER_ID_PATTERN);

/**
 * Seed providers for bootstrap/fixtures.
 * These are not contract authority; runtime accepts any slug-matching provider id.
 */
export const PROVIDER_IDS = [
  "axis",
  "openrouter",
  "openai",
  "groq",
  "anthropic",
  "google",
  "together",
  "cerebras",
  "mistral",
  "cohere",
  "opencode-go",
  "opencode-zen",
  "cloudflare-ai",
] as const;

export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROVIDER_ID_REGEX);
declare const providerIdBrand: unique symbol;
export type ProviderId = z.infer<typeof ProviderIdSchema> & {
  readonly [providerIdBrand]?: true;
};

export const ProviderCapabilityFlagsSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  structuredOutputs: z.boolean(),
  jsonMode: z.boolean(),
});
export type ProviderCapabilityFlags = z.infer<
  typeof ProviderCapabilityFlagsSchema
>;

export const ModelDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: ProviderIdSchema,
  contextWindow: z.number().int().positive().optional(),
  costPer1kTokens: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
    })
    .optional(),
  description: z.string().optional(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const ProviderCatalogEntrySchema = z.object({
  providerId: ProviderIdSchema,
  displayName: z.string().min(1),
  capabilities: ProviderCapabilityFlagsSchema,
  models: z.array(ModelDescriptorSchema),
});
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;

export const ProviderCatalogResponseSchema = z.object({
  providers: z.array(ProviderCatalogEntrySchema),
  generatedAt: z.string().datetime(),
});
export type ProviderCatalogResponse = z.infer<
  typeof ProviderCatalogResponseSchema
>;

export const ProviderConnectionStateSchema = z.enum([
  "connected",
  "disconnected",
  "failed",
  "revoked",
]);
export type ProviderConnectionState = z.infer<
  typeof ProviderConnectionStateSchema
>;

export const ProviderErrorCodeSchema = z.enum([
  "AUTH_FAILED",
  "MODEL_NOT_ALLOWED",
  "RATE_LIMITED",
  "AXIS_DAILY_LIMIT_EXCEEDED",
  "PROVIDER_NOT_CONNECTED",
  "INVALID_PROVIDER_SELECTION",
  "PROVIDER_UNAVAILABLE",
  "VALIDATION_ERROR",
  "INTERNAL_ERROR",
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

export const CloudflareAIConnectionConfigSchema = z.object({
  providerId: z.literal("cloudflare-ai"),
  accountId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  gatewayId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  routeMode: z.enum(["workers-ai-direct", "ai-gateway"]),
});
export type CloudflareAIConnectionConfig = z.infer<
  typeof CloudflareAIConnectionConfigSchema
>;

export const EmptyProviderConnectionConfigSchema = z.object({
  providerId: z.enum(["opencode-go", "opencode-zen"]),
});
export type EmptyProviderConnectionConfig = z.infer<
  typeof EmptyProviderConnectionConfigSchema
>;

export const ProviderConnectionConfigSchema = z.discriminatedUnion(
  "providerId",
  [CloudflareAIConnectionConfigSchema, EmptyProviderConnectionConfigSchema],
);
export type ProviderConnectionConfig = z.infer<
  typeof ProviderConnectionConfigSchema
>;

export const ProviderConnectionSchema = z.object({
  providerId: ProviderIdSchema,
  status: ProviderConnectionStateSchema,
  lastValidatedAt: z.string().datetime().optional(),
  keyFingerprint: z.string().optional(),
  errorCode: ProviderErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  capabilities: ProviderCapabilityFlagsSchema.optional(),
  config: ProviderConnectionConfigSchema.optional(),
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

export const ProviderConnectionsResponseSchema = z.object({
  connections: z.array(ProviderConnectionSchema),
});
export type ProviderConnectionsResponse = z.infer<
  typeof ProviderConnectionsResponseSchema
>;

export const BYOKConnectRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    apiKey: z.string().min(1).max(4096),
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
export type BYOKConnectRequest = z.infer<typeof BYOKConnectRequestSchema>;

export const BYOKConnectResponseSchema = z.object({
  status: z.enum(["connected", "failed"]),
  providerId: ProviderIdSchema,
  lastValidatedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional(),
});
export type BYOKConnectResponse = z.infer<typeof BYOKConnectResponseSchema>;

export const BYOKDisconnectRequestSchema = z.object({
  providerId: ProviderIdSchema,
});
export type BYOKDisconnectRequest = z.infer<typeof BYOKDisconnectRequestSchema>;

export const BYOKDisconnectResponseSchema = z.object({
  status: z.literal("disconnected"),
  providerId: ProviderIdSchema,
});
export type BYOKDisconnectResponse = z.infer<
  typeof BYOKDisconnectResponseSchema
>;

export const BYOKValidationModeSchema = z.enum(["format", "live"]);
export type BYOKValidationMode = z.infer<typeof BYOKValidationModeSchema>;

export const BYOKValidateRequestSchema = z.object({
  providerId: ProviderIdSchema,
  mode: BYOKValidationModeSchema.optional(),
});
export type BYOKValidateRequest = z.infer<typeof BYOKValidateRequestSchema>;

export const BYOKValidateResponseSchema = z.object({
  providerId: ProviderIdSchema,
  status: z.enum(["valid", "invalid"]),
  checkedAt: z.string().datetime(),
  validationMode: BYOKValidationModeSchema.optional(),
});
export type BYOKValidateResponse = z.infer<typeof BYOKValidateResponseSchema>;

export const BYOKPreferencesPatchSchema = z
  .object({
    defaultProviderId: ProviderIdSchema.optional(),
    defaultModelId: z.string().min(1).optional(),
    visibleModelIds: z.record(z.string(), z.array(z.string())).optional(),
  })
  .refine(
    (value) =>
      value.defaultProviderId !== undefined ||
      value.defaultModelId !== undefined ||
      value.visibleModelIds !== undefined,
    {
      message: "At least one preference field is required",
    },
  );
export type BYOKPreferencesPatch = z.infer<typeof BYOKPreferencesPatchSchema>;

export const BYOKPreferencesSchema = z.object({
  defaultProviderId: ProviderIdSchema.optional(),
  defaultModelId: z.string().min(1).optional(),
  visibleModelIds: z.record(z.string(), z.array(z.string())).optional(),
  credentialLabels: z.record(z.string(), z.string()).optional(),
  updatedAt: z.string().datetime(),
});
export type BYOKPreferences = z.infer<typeof BYOKPreferencesSchema>;

export const NormalizedProviderErrorSchema = z.object({
  code: ProviderErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  correlationId: z.string().optional(),
});
export type NormalizedProviderError = z.infer<
  typeof NormalizedProviderErrorSchema
>;

export const ProviderErrorEnvelopeSchema = z.object({
  error: NormalizedProviderErrorSchema,
});
export type ProviderErrorEnvelope = z.infer<typeof ProviderErrorEnvelopeSchema>;
