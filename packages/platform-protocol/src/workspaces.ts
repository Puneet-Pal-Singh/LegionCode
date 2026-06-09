import { z } from "zod";
import { WorkerExecutionLocationSchema } from "./capabilities.js";
import { ProtocolTimestampSchema } from "./common.js";
import {
  PermissionProfileIdSchema,
  RunIdSchema,
  UserIdSchema,
  WorkerIdSchema,
  WorkspaceIdSchema,
  WorkspaceManifestIdSchema,
} from "./ids.js";

export const WorkspaceManifestStateSchema = z.enum([
  "preparing",
  "ready",
  "dirty",
  "failed",
  "archived",
]);
export type WorkspaceManifestState = z.infer<
  typeof WorkspaceManifestStateSchema
>;

export const GitCommitShaSchema = z
  .string()
  .min(7)
  .max(64)
  .regex(/^[a-fA-F0-9]+$/);
export type GitCommitSha = z.infer<typeof GitCommitShaSchema>;

export const WorkspaceManifestSchema = z
  .object({
    manifestId: WorkspaceManifestIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    userId: UserIdSchema,
    workerId: WorkerIdSchema,
    permissionProfileId: PermissionProfileIdSchema,
    repoOwner: z.string().min(1).max(200),
    repoName: z.string().min(1).max(200),
    repoUrl: z.string().url(),
    baseBranch: z.string().min(1).max(240),
    workingBranch: z.string().min(1).max(240),
    baseCommitSha: GitCommitShaSchema,
    headCommitSha: GitCommitShaSchema,
    executionLocation: WorkerExecutionLocationSchema,
    filesystemRoot: z.string().min(1).max(2_048),
    artifactNamespace: z.string().min(1).max(512),
    state: WorkspaceManifestStateSchema,
    lastError: z.string().min(1).max(2_000).nullable(),
    createdAt: ProtocolTimestampSchema,
    updatedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export function buildWorkspaceManifestStateSqlList(): string {
  return buildSqlList(WorkspaceManifestStateSchema.options);
}

function buildSqlList(values: readonly string[]): string {
  return values.map(quoteSqlLiteral).join(", ");
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
