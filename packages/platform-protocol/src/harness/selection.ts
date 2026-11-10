import { z } from "zod";
import { ModelIdSchema } from "../ids.js";
import { HarnessKindSchema } from "./kind.js";

const Reference = z.string().trim().min(1).max(256);
/** Pre-admission intent: no attempt IDs, external IDs, policy pins or secrets.
 * This is the shared definition re-exported by harness operations. */
export const HarnessNextSelectionSchema = z
  .object({
    harness: HarnessKindSchema,
    instanceId: Reference,
    connectionId: Reference,
    modelId: ModelIdSchema,
  })
  .strict()
  .readonly();
export type HarnessNextSelection = z.infer<typeof HarnessNextSelectionSchema>;

/** Explicit placement and selection revision travel together. Null selects the
 * native strategy; omission lets existing native clients retain their contract.
 * The admission owner validates revision/eligibility and resolves runtime pins. */
export const HarnessAdmissionSelectionSchema = z
  .object({
    environmentId: Reference,
    selectionRevision: z.number().int().safe().nonnegative(),
    selection: HarnessNextSelectionSchema.nullable(),
  })
  .strict()
  .readonly();
export type HarnessAdmissionSelection = z.infer<
  typeof HarnessAdmissionSelectionSchema
>;
