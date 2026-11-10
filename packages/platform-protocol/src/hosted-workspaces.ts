import { z } from "zod";

// Persisted hosted repository/workspace records are distinct from local grants.
export const HostedWorkspaceSelectRequestSchema = z.object({
  repository: z.object({ owner: z.string().min(1), name: z.string().min(1) }).strict(),
  selectedBranch: z.string().min(1),
}).strict();
export const HostedWorkspaceRepositorySchema = z.object({
  id: z.string(), provider: z.string(), owner: z.string(), name: z.string(),
  fullName: z.string(), repoUrl: z.string(), defaultBranch: z.string(),
  providerRepoId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const HostedWorkspaceRecordSchema = z.object({
  id: z.string(), userId: z.string(), repoId: z.string(), name: z.string(),
  defaultBranch: z.string(), lastSelectedBranch: z.string(),
  status: z.enum(["active", "archived"]), createdAt: z.string(),
  updatedAt: z.string(), lastOpenedAt: z.string(),
}).strict();
export const HostedWorkspaceSelectionSchema = z.object({
  workspaceId: z.string(), repoId: z.string(), selectedBranch: z.string(),
  repository: HostedWorkspaceRepositorySchema, workspaceName: z.string(), updatedAt: z.string(),
}).strict();
export const HostedWorkspaceListItemSchema = z.object({
  repository: HostedWorkspaceRepositorySchema, workspace: HostedWorkspaceRecordSchema,
  selected: z.boolean(),
}).strict();
export const HostedWorkspaceListResponseSchema = z.object({
  workspaces: z.array(HostedWorkspaceListItemSchema), selection: HostedWorkspaceSelectionSchema.nullable(),
}).strict();
export const HostedWorkspaceSelectResponseSchema = z.object({ selection: HostedWorkspaceSelectionSchema }).strict();
export type HostedWorkspaceSelectRequest = z.infer<typeof HostedWorkspaceSelectRequestSchema>;
export type HostedWorkspaceRepository = z.infer<typeof HostedWorkspaceRepositorySchema>;
export type HostedWorkspaceRecord = z.infer<typeof HostedWorkspaceRecordSchema>;
export type HostedWorkspaceSelection = z.infer<typeof HostedWorkspaceSelectionSchema>;
export type HostedWorkspaceListItem = z.infer<typeof HostedWorkspaceListItemSchema>;
export type HostedWorkspaceListResponse = z.infer<typeof HostedWorkspaceListResponseSchema>;

// Saved primary-repository configuration; deliberately contains no machine state.
export const HostedWorkspaceConfigurationReadRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
  })
  .strict();
const WorkspaceNameSchema = z.string().trim().min(1).max(200);
const WorkspaceBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (branch) =>
      !branch.startsWith("-") &&
      !branch.startsWith("/") &&
      !branch.endsWith("/") &&
      !branch.endsWith(".") &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !Array.from(branch).some((character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || "~^:?*[\\".includes(character),
      ) &&
      branch
        .split("/")
        .every(
          (part) =>
            part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
        ),
    "Invalid branch name",
  );
export const HostedWorkspaceConfigurationUpdateRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    patch: z
      .object({
        name: WorkspaceNameSchema.optional(),
        selectedBranch: WorkspaceBranchSchema.optional(),
      })
      .strict()
      .refine(
        (patch) =>
          patch.name !== undefined || patch.selectedBranch !== undefined,
        "Provide a configuration change",
      ),
  })
  .strict();
export const HostedWorkspaceConfigurationSchema = z
  .object({
    workspaceId: z.string().min(1),
    repository: HostedWorkspaceRepositorySchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string(),
    selectedBranch: z.string(),
  })
  .strict();
export type HostedWorkspaceConfigurationReadRequest = z.infer<
  typeof HostedWorkspaceConfigurationReadRequestSchema
>;
export type HostedWorkspaceConfigurationUpdateRequest = z.infer<
  typeof HostedWorkspaceConfigurationUpdateRequestSchema
>;
export type HostedWorkspaceConfiguration = z.infer<
  typeof HostedWorkspaceConfigurationSchema
>;
