import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Private Main-to-utility metadata only; validation never connects or qualifies a service. */
export const NativeHostBrokerConfigurationSchema = z.object({
  bridgePath: z.string().min(2).max(4096)
    .refine((path) => path.startsWith("/") && !path.includes("\0"), "An absolute bridge path is required"),
  serviceCodeRequirement: z.string().min(1).max(4096)
    .refine((requirement) => requirement.trim().length > 0 && !requirement.includes("\0"), "A service code requirement is required"),
  expectedPolicySHA256: DigestSchema,
  expectedPolicyGeneration: DigestSchema,
  generation: DigestSchema,
  configurationSHA256: DigestSchema,
}).strict().readonly();

export type NativeHostBrokerConfiguration = z.infer<typeof NativeHostBrokerConfigurationSchema>;
