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
    processGeneration: Generation,
    source: OpaqueId,
    observedAt: ProtocolTimestampSchema,
    aggregation: z.enum(["delta", "cumulative"]),
    scope: z.enum(["request", "session", "attempt"]),
    childCoverage: z.enum(["self_only", "includes_children", "unknown"]),
    measurementSource: z.enum(["provider", "estimate"]),
    inputTokens: NullableCount,
    outputTokens: NullableCount,
    cachedInputTokens: NullableCount,
    reasoningTokens: NullableCount,
    totalTokens: NullableCount,
  })
  .strict();
export type HarnessActivityMeasurement = z.infer<
  typeof HarnessActivityMeasurementSchema
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
  })
  .strict();
export type HarnessUsageObservation = z.infer<
  typeof HarnessUsageObservationSchema
>;
