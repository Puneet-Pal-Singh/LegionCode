import { z } from "zod";
import { ChatRunModeSchema } from "./run-mode.js";
import { PRODUCT_MODES, ProductModeSchema } from "./permissions.js";
import { ModelIdSchema, ProviderIdSchema, type ModelId, type ProviderId } from "./ids.js";

/** Complete immutable configuration captured when a local Turn is admitted. */
export const LocalTurnConfigurationSchema = z.object({
  mode: ChatRunModeSchema.default("plan"),
  productMode: ProductModeSchema.default(PRODUCT_MODES.ASK_ALWAYS),
}).strict();

export type LocalTurnConfiguration = z.infer<typeof LocalTurnConfigurationSchema>;

const LocalQueuedInputConfigurationSchema = z.object({
  mode: z.enum(["plan", "auto_edit"]).optional(),
  productMode: ProductModeSchema.optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: ModelIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.providerId === undefined) !== (value.modelId === undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["providerId"],
      message: "Provider and model must be supplied together" });
});

export interface LocalQueuedInputConfiguration {
  readonly configuration: LocalTurnConfiguration;
  readonly expectedSelection?: { readonly providerId: ProviderId; readonly modelId: ModelId };
}

/** Interpret captured Native intent only; never inherit current UI or runtime policy. */
export function parseLocalQueuedInputConfiguration(value: unknown): LocalQueuedInputConfiguration {
  const captured = LocalQueuedInputConfigurationSchema.parse(value);
  return Object.freeze({
    configuration: Object.freeze(LocalTurnConfigurationSchema.parse({
      mode: captured.mode === "auto_edit" ? "build" : "plan", productMode: captured.productMode,
    })),
    ...(captured.providerId !== undefined && captured.modelId !== undefined ? {
      expectedSelection: Object.freeze({ providerId: captured.providerId, modelId: captured.modelId }),
    } : {}),
  });
}

/** Availability is projected from the host's actually composed execution and policy ports. */
export const LocalTurnMediaLimitsSchema = z.object({
  maxImages: z.number().int().positive().max(8),
  maxImageBytes: z.number().int().positive().safe(),
  maxTotalBytes: z.number().int().positive().safe(),
}).strict();

export type LocalTurnMediaLimits = z.infer<typeof LocalTurnMediaLimitsSchema>;

export const LocalTurnConfigurationOptionsSchema = z.object({
  modes: z.array(ChatRunModeSchema).min(1).max(2),
  productModes: z.array(ProductModeSchema).min(1).max(4),
  productModesByMode: z.record(ChatRunModeSchema, z.array(ProductModeSchema).min(1).max(4)).optional(),
  attachments: LocalTurnMediaLimitsSchema.optional(),
}).strict();

export type LocalTurnConfigurationOptions = z.infer<typeof LocalTurnConfigurationOptionsSchema>;
