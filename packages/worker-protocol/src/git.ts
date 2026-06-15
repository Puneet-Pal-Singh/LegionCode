import { z } from "zod";
import {
  ByteCountSchema,
  Sha256Schema,
  WorkspaceRelativePathSchema,
} from "./common.js";

export const GitRefNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/);
export type GitRefName = z.infer<typeof GitRefNameSchema>;

export const GitShaSchema = z.string().regex(/^[a-f0-9]{7,64}$/);
export type GitSha = z.infer<typeof GitShaSchema>;

export const GitChangedFileStatusSchema = z.enum([
  "added",
  "copied",
  "deleted",
  "modified",
  "renamed",
  "type_changed",
  "unmerged",
  "untracked",
]);
export type GitChangedFileStatus = z.infer<typeof GitChangedFileStatusSchema>;

export const GitPathFilterRequestSchema = z
  .object({
    paths: z.array(WorkspaceRelativePathSchema).max(2_000),
  })
  .strict();
export type GitPathFilterRequest = z.infer<typeof GitPathFilterRequestSchema>;

export const GitStatusRequestSchema = GitPathFilterRequestSchema;
export type GitStatusRequest = z.infer<typeof GitStatusRequestSchema>;

export const GitDiffRequestSchema = z
  .object({
    paths: z.array(WorkspaceRelativePathSchema).max(2_000),
    staged: z.boolean(),
  })
  .strict();
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>;

export const GitStageRequestSchema = z
  .object({
    paths: z.array(WorkspaceRelativePathSchema).min(1).max(2_000),
  })
  .strict();
export type GitStageRequest = z.infer<typeof GitStageRequestSchema>;

export const GitCommitIdentitySchema = z
  .object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(320),
  })
  .strict();
export type GitCommitIdentity = z.infer<typeof GitCommitIdentitySchema>;

export const GitCommitRequestSchema = z
  .object({
    paths: z.array(WorkspaceRelativePathSchema).min(1).max(2_000),
    message: z.string().min(1).max(10_000),
    author: GitCommitIdentitySchema,
  })
  .strict();
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>;

export const GitPushRequestSchema = z
  .object({
    remoteName: z.string().min(1).max(128),
    branchName: GitRefNameSchema,
  })
  .strict();
export type GitPushRequest = z.infer<typeof GitPushRequestSchema>;

export const GitBranchStatusSchema = z
  .object({
    head: GitRefNameSchema.nullable(),
    upstream: GitRefNameSchema.nullable(),
    headSha: GitShaSchema.nullable(),
    ahead: z.number().int().safe().nonnegative().nullable(),
    behind: z.number().int().safe().nonnegative().nullable(),
    detached: z.boolean(),
  })
  .strict();
export type GitBranchStatus = z.infer<typeof GitBranchStatusSchema>;

export const GitChangedFileSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    previousPath: WorkspaceRelativePathSchema.nullable(),
    status: GitChangedFileStatusSchema,
    additions: z.number().int().safe().nonnegative().nullable(),
    deletions: z.number().int().safe().nonnegative().nullable(),
  })
  .strict();
export type GitChangedFile = z.infer<typeof GitChangedFileSchema>;

export const GitStatusResponseSchema = z
  .object({
    branch: GitBranchStatusSchema,
    files: z.array(GitChangedFileSchema).max(2_000),
    changedFileCount: z.number().int().safe().nonnegative(),
    isDirty: z.boolean(),
  })
  .strict();
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;

export const GitDiffResponseSchema = z
  .object({
    files: z.array(GitChangedFileSchema).max(2_000),
    patch: z.string().max(10_000_000),
    patchSha256: Sha256Schema,
    sizeBytes: ByteCountSchema,
  })
  .strict();
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;

export const GitStageResponseSchema = GitStatusResponseSchema;
export type GitStageResponse = z.infer<typeof GitStageResponseSchema>;

export const GitCommitResponseSchema = z
  .object({
    commitSha: GitShaSchema,
    branchName: GitRefNameSchema,
    committedPaths: z.array(WorkspaceRelativePathSchema).max(2_000),
  })
  .strict();
export type GitCommitResponse = z.infer<typeof GitCommitResponseSchema>;

export const GitPushResponseSchema = z
  .object({
    remoteName: z.string().min(1).max(128),
    branchName: GitRefNameSchema,
    headSha: GitShaSchema,
  })
  .strict();
export type GitPushResponse = z.infer<typeof GitPushResponseSchema>;
