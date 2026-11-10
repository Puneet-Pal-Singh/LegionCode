import { z } from "zod";
import {
  HarnessActivityMeasurementSchema,
  HarnessProviderLimitNotificationSchema,
} from "./usage.js";

/** Measurements retain provider aggregation/child provenance; never a balance. */
export const HarnessActivityMeasuredPayloadSchema = z
  .object({
    measurement: HarnessActivityMeasurementSchema,
  })
  .strict();
export type HarnessActivityMeasuredPayload = z.infer<
  typeof HarnessActivityMeasuredPayloadSchema
>;
/** Passive scoped provider limits are separate from account quota polling. */
export const HarnessProviderLimitNotifiedPayloadSchema = z
  .object({
    notification: HarnessProviderLimitNotificationSchema,
  })
  .strict();
export type HarnessProviderLimitNotifiedPayload = z.infer<
  typeof HarnessProviderLimitNotifiedPayloadSchema
>;
