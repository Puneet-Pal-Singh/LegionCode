import { z } from "zod";
import { ProtocolTimestampSchema } from "../common.js";
import {
  ModelIdSchema,
  ProviderIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from "../ids.js";
const OpaqueId = z.string().min(1).max(256);
const NullableCount = z.number().int().safe().nonnegative().nullable();
const Generation = z.number().int().safe().nonnegative();
export const HarnessBillingRouteSchema = z.enum([
  "subscription",
  "api_key",
  "external",
]);
export type HarnessBillingRoute = z.infer<typeof HarnessBillingRouteSchema>;
export const HarnessQuotaWindowSchema = z
  .object({
    bucketId: OpaqueId.nullable(),
    label: z.string().min(1).max(256).nullable(),
    utilizationPercent: z.number().finite().nonnegative().nullable(),
    remaining: z.number().finite().nonnegative().nullable(),
    limit: z.number().finite().nonnegative().nullable(),
    unit: z.string().min(1).max(80).nullable(),
    resetsAt: ProtocolTimestampSchema.nullable(),
  })
  .strict();
export type HarnessQuotaWindow = z.infer<typeof HarnessQuotaWindowSchema>;
/** Account-wide observations. Host owns freshness; missing numbers stay null. */
export const HarnessAccountQuotaSchema = z.discriminatedUnion("state", [
  z
    .object({
      scope: z.literal("account"),
      state: z.literal("fresh"),
      checkedAt: ProtocolTimestampSchema,
      source: OpaqueId,
      windows: z.array(HarnessQuotaWindowSchema).max(32),
    })
    .strict(),
  z
    .object({
      scope: z.literal("account"),
      state: z.literal("stale"),
      checkedAt: ProtocolTimestampSchema,
      source: OpaqueId,
      windows: z.array(HarnessQuotaWindowSchema).max(32),
    })
    .strict(),
  z
    .object({
      scope: z.literal("account"),
      state: z.literal("unavailable"),
      checkedAt: ProtocolTimestampSchema.nullable(),
      source: OpaqueId.nullable(),
      windows: z.null(),
    })
    .strict(),
  z
    .object({
      scope: z.literal("account"),
      state: z.literal("unsupported"),
      checkedAt: ProtocolTimestampSchema.nullable(),
      source: OpaqueId.nullable(),
      windows: z.null(),
    })
    .strict(),
]);
export type HarnessAccountQuota = z.infer<typeof HarnessAccountQuotaSchema>;
/** One measurement, not an additive balance; scope and child coverage are explicit. */
export const HarnessActivityMeasurementSchema = z
  .object({
    measurementId: OpaqueId,
    sequence: Generation,
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    instanceId: OpaqueId,
    externalSessionId: OpaqueId,
    parentExternalSessionId: OpaqueId.nullable(),
    processGeneration: z.string().uuid(),
    source: OpaqueId,
    observedAt: ProtocolTimestampSchema,
    aggregation: z.enum(["delta", "cumulative"]),
    scope: z.enum(["request", "session", "attempt"]),
    childCoverage: z.enum(["self_only", "includes_children", "unknown"]),
    measurementSource: z.enum(["provider", "estimate"]),
    /** Total input: uncached input plus cache reads and cache creation when reported. */
    inputTokens: NullableCount,
    uncachedInputTokens: NullableCount,
    cacheReadInputTokens: NullableCount,
    cacheCreationInputTokens: NullableCount,
    outputTokens: NullableCount,
    /** Combined cache reads and creation, when both are known. */
    cachedInputTokens: NullableCount,
    /** Reasoning is already included in outputTokens; never add it again. */
    reasoningTokens: NullableCount,
    totalTokens: NullableCount,
    /** Provider SDK monetary estimate, never a subscription charge or balance. */
    estimatedCostUsd: z.number().finite().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const {
      uncachedInputTokens: uncached,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: creation,
    } = value;
    if (
      uncached !== null &&
      read !== null &&
      creation !== null &&
      value.inputTokens !== null &&
      value.inputTokens !== uncached + read + creation
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputTokens"],
        message:
          "Input total must include uncached input and both cache categories",
      });
    if (
      read !== null &&
      creation !== null &&
      value.cachedInputTokens !== null &&
      value.cachedInputTokens !== read + creation
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cachedInputTokens"],
        message: "Combined cache input must equal reads plus creation",
      });
    if (
      value.inputTokens !== null &&
      value.outputTokens !== null &&
      value.totalTokens !== null &&
      value.totalTokens !== value.inputTokens + value.outputTokens
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalTokens"],
        message:
          "Token total must equal input plus output; reasoning is already included",
      });
  });
export type HarnessActivityMeasurement = z.infer<
  typeof HarnessActivityMeasurementSchema
>;
/** Supported passive limit signal. Never an account-wide quota observation. */
export const HarnessProviderLimitNotificationSchema = z
  .object({
    notificationId: OpaqueId,
    sequence: Generation,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    instanceId: OpaqueId,
    externalSessionId: OpaqueId,
    processGeneration: z.string().uuid(),
    modelId: ModelIdSchema.nullable(),
    source: OpaqueId,
    observedAt: ProtocolTimestampSchema,
    scope: z.enum(["session", "model", "account", "unknown"]),
    status: z.enum(["allowed", "warning", "limited", "unknown"]),
    limitKind: OpaqueId.nullable(),
    resetsAt: ProtocolTimestampSchema.nullable(),
  })
  .strict();
export type HarnessProviderLimitNotification = z.infer<
  typeof HarnessProviderLimitNotificationSchema
>;
/** Redacted read payload; no secrets, inferred payer or invented charge balance. */
export const HarnessUsageObservationSchema = z
  .object({
    connectionId: OpaqueId,
    accountId: OpaqueId,
    environmentId: OpaqueId,
    authOwnerGeneration: Generation,
    billingRoute: HarnessBillingRouteSchema,
    quota: HarnessAccountQuotaSchema,
    activity: z.array(HarnessActivityMeasurementSchema).max(1000),
    providerLimits: z.array(HarnessProviderLimitNotificationSchema).max(1000),
  })
  .strict();
export type HarnessUsageObservation = z.infer<
  typeof HarnessUsageObservationSchema
>;
