import { z } from "zod";

/** Nonsecret custody reference. This is not a public operation or secret payload. */
export const RuntimeCredentialReferenceSchema = z.object({
  connectionId: z.string().uuid(),
  // Preserve the protected credential owner's strict slug domain and unbranded
  // output; general public provider IDs intentionally have a broader grammar.
  providerId: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ownerGeneration: z.number().int().safe().positive(),
  tokenMaterialVersion: z.number().int().safe().positive(),
}).strict();

export type RuntimeCredentialReference = z.infer<typeof RuntimeCredentialReferenceSchema>;
