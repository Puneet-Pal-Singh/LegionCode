import { z } from "zod";

export const HOSTED_ACCOUNT_CHANNEL = "desktop:hosted-account";
export const HostedAccountCommandSchema = z.object({
  operation: z.enum(["status", "connect", "disconnect"]),
}).strict();
export const HostedAccountSnapshotSchema = z.object({
  target: z.literal("production"),
  state: z.enum(["signed_out", "connecting", "signed_in", "unavailable", "sign_out_failed"]),
  generation: z.number().int().nonnegative(),
  account: z.object({ id: z.string().min(1), login: z.string().min(1) }).strict().optional(),
}).strict();
export type HostedAccountSnapshot = z.infer<typeof HostedAccountSnapshotSchema>;
export type HostedAccountCommand = z.infer<typeof HostedAccountCommandSchema>;
