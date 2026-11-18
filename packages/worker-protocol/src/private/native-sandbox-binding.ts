import { z } from "zod";

/** Private physical namespace selection, not image or OS qualification proof.
 * Conversation/domain scope remains on its existing canonical session/lease. */
export const NativeSandboxPhysicalBindingSchema = z
  .object({
    version: z.literal(1),
    backend: z.literal("cloudflareSandbox"),
    binding: z.literal("NativeSandbox"),
    profile: z.literal("basic"),
    schedulingPolicy: z.literal("default"),
    sandboxObjectId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NativeSandboxPhysicalBinding = z.infer<
  typeof NativeSandboxPhysicalBindingSchema
>;

/** Snapshot before an await; retain this exact record with the original owner. */
export function snapshotNativeSandboxPhysicalBinding(
  value: unknown,
): NativeSandboxPhysicalBinding {
  return Object.freeze(NativeSandboxPhysicalBindingSchema.parse(value));
}
