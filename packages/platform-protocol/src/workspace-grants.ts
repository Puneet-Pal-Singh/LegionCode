import { z } from "zod";

import { ProtocolTimestampSchema } from "./common.js";
import { WorkspaceIdSchema } from "./ids.js";

export const LocalWorkspaceReadinessSchema = z.enum([
  "ready",
  "missing",
  "invalid",
]);
export type LocalWorkspaceReadiness = z.infer<
  typeof LocalWorkspaceReadinessSchema
>;

export const LocalWorkspaceCapabilitySchema = z.enum(["filesystem", "git"]);
export type LocalWorkspaceCapability = z.infer<
  typeof LocalWorkspaceCapabilitySchema
>;

export const LocalWorkspaceGrantSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    displayName: z.string().min(1).max(255),
    repositoryIdentity: z.string().min(1).max(2_048).nullable(),
    branch: z.string().min(1).max(240).nullable(),
    readiness: LocalWorkspaceReadinessSchema,
    capabilities: z.array(LocalWorkspaceCapabilitySchema).max(10),
    reason: z.string().min(1).max(500).nullable(),
    grantedAt: ProtocolTimestampSchema,
  })
  .strict();
export type LocalWorkspaceGrant = z.infer<typeof LocalWorkspaceGrantSchema>;

export const LocalWorkspaceGrantPathSchema = z
  .string()
  .min(1)
  .max(4_096);

export const GrantLocalWorkspaceRequestSchema = z
  .object({
    path: LocalWorkspaceGrantPathSchema,
  })
  .strict();
export type GrantLocalWorkspaceRequest = z.infer<
  typeof GrantLocalWorkspaceRequestSchema
>;

export const LocalWorkspaceGrantResponseSchema = z
  .object({
    grant: LocalWorkspaceGrantSchema.nullable(),
  })
  .strict();
export type LocalWorkspaceGrantResponse = z.infer<
  typeof LocalWorkspaceGrantResponseSchema
>;
