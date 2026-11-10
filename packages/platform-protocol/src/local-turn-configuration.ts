import { z } from "zod";
import { ChatRunModeSchema } from "./run-mode.js";
import { PRODUCT_MODES, ProductModeSchema } from "./permissions.js";

/** Complete immutable configuration captured when a local Turn is admitted. */
export const LocalTurnConfigurationSchema = z.object({
  mode: ChatRunModeSchema.default("plan"),
  productMode: ProductModeSchema.default(PRODUCT_MODES.ASK_ALWAYS),
}).strict();

export type LocalTurnConfiguration = z.infer<typeof LocalTurnConfigurationSchema>;

/** Availability is projected from the host's actually composed execution and policy ports. */
export const LocalTurnMediaLimitsSchema = z.object({
  maxImages: z.number().int().positive().max(8),
  maxImageBytes: z.number().int().positive().safe(),
  maxTotalBytes: z.number().int().positive().safe(),
}).strict();

export type LocalTurnMediaLimits = z.infer<typeof LocalTurnMediaLimitsSchema>;

/** Declared agent command backend; independent of approvals and artifact capture. */
export const LocalCommandExecutionProfileSchema = z.enum([
  "unavailable",
  "single_executable_nofork",
]);

export type LocalCommandExecutionProfile = z.infer<typeof LocalCommandExecutionProfileSchema>;

export const LocalTurnConfigurationOptionsSchema = z.object({
  modes: z.array(ChatRunModeSchema).min(1).max(2),
  productModes: z.array(ProductModeSchema).min(1).max(4),
  productModesByMode: z.record(ChatRunModeSchema, z.array(ProductModeSchema).min(1).max(4)).optional(),
  /** Omitted entries are unknown, never an inferred execution or isolation promise. */
  commandExecution: z.record(ChatRunModeSchema, LocalCommandExecutionProfileSchema).optional(),
  attachments: LocalTurnMediaLimitsSchema.optional(),
}).strict();

export type LocalTurnConfigurationOptions = z.infer<typeof LocalTurnConfigurationOptionsSchema>;
