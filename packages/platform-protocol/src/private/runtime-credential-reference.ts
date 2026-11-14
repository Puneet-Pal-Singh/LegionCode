import { z } from "zod";

export const RUNTIME_CREDENTIAL_PROVIDER_ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
export const RuntimeCredentialProviderIdSchema = z.string().min(1).max(64)
  .regex(new RegExp(RUNTIME_CREDENTIAL_PROVIDER_ID_PATTERN));

/** Nonsecret custody reference. This is not a public operation or secret payload. */
export const RuntimeCredentialReferenceSchema = z.object({
  connectionId: z.string().uuid(),
  // Preserve the protected credential owner's strict slug domain and unbranded
  // output; general public provider IDs intentionally have a broader grammar.
  providerId: RuntimeCredentialProviderIdSchema,
  ownerGeneration: z.number().int().safe().positive(),
  tokenMaterialVersion: z.number().int().safe().positive(),
}).strict();

export type RuntimeCredentialReference = z.infer<typeof RuntimeCredentialReferenceSchema>;
