import { z } from "zod";

import { ProtocolTimestampSchema } from "./common.js";
import { ThreadSchema } from "./conversation.js";
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

/** Navigation metadata only; none of these records grants filesystem access. */
export const LocalWorkspaceProjectSchema = z.discriminatedUnion("association", [
  z.object({
    association: z.literal("known"),
    workspaceId: WorkspaceIdSchema,
    displayName: LocalWorkspaceGrantSchema.shape.displayName,
    repositoryIdentity: LocalWorkspaceGrantSchema.shape.repositoryIdentity,
    lastOpenedAt: ProtocolTimestampSchema,
  }).strict(),
  z.object({
    association: z.literal("unlinked"),
    workspaceId: WorkspaceIdSchema,
    displayName: z.null(),
    repositoryIdentity: z.null(),
    lastOpenedAt: z.null(),
  }).strict(),
]);
export type LocalWorkspaceProject = z.infer<typeof LocalWorkspaceProjectSchema>;

/** Local navigation is separate from hosted workspace selection and live grants. */
export const LocalWorkspaceProjectsResponseSchema = z.object({
  projects: z.array(LocalWorkspaceProjectSchema),
  threads: z.array(ThreadSchema),
  selectedWorkspaceId: WorkspaceIdSchema.nullable(),
}).strict();
export type LocalWorkspaceProjectsResponse = z.infer<typeof LocalWorkspaceProjectsResponseSchema>;
