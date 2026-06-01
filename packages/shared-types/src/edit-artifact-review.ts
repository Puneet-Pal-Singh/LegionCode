import { z } from "zod";

export const EditArtifactReviewScopeSchema = z.enum([
  "prompt_artifact",
  "live_git",
]);

export const EditArtifactReviewFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  isStaged: z.boolean().optional(),
  diffAvailable: z.boolean(),
  artifactPath: z.string().min(1).optional(),
});

export const EditArtifactStorageBackendSchema = z.enum([
  "r2_postgres",
  "cloudflare_artifacts",
]);

export const PromptArtifactReviewSourceSchema = z.object({
  kind: z.literal("prompt_artifact"),
  artifactId: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  userMessageId: z.string().min(1).optional(),
  assistantMessageId: z.string().min(1).optional(),
  sourceTurnId: z.string().min(1).optional(),
  status: z.enum(["stored", "restored", "requires_user_resolution"]),
  files: z.array(EditArtifactReviewFileSchema),
  createdAt: z.string().min(1),
  storageBackend: EditArtifactStorageBackendSchema,
});

export const LiveGitReviewSourceSchema = z.object({
  kind: z.literal("live_git"),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  files: z.array(EditArtifactReviewFileSchema),
});

export const DiffLineSchema = z.object({
  type: z.enum(["unchanged", "added", "deleted"]),
  content: z.string(),
  oldLineNumber: z.number().int().nonnegative().optional(),
  newLineNumber: z.number().int().nonnegative().optional(),
});

export const DiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(DiffLineSchema),
  header: z.string(),
});

export const DiffContentSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  hunks: z.array(DiffHunkSchema),
  isBinary: z.boolean(),
  isNewFile: z.boolean(),
  isDeleted: z.boolean(),
});

export const EditArtifactReviewSourceSchema = z.discriminatedUnion("kind", [
  PromptArtifactReviewSourceSchema,
  LiveGitReviewSourceSchema,
]);

export const EditArtifactDiffResponseSchema = z.object({
  artifactId: z.string().min(1),
  path: z.string().min(1),
  source: z.enum(["artifact_patch", "artifact_snapshot", "live_git"]),
  diff: DiffContentSchema,
});

export type EditArtifactReviewScope = z.infer<
  typeof EditArtifactReviewScopeSchema
>;
export type EditArtifactReviewFile = z.infer<
  typeof EditArtifactReviewFileSchema
>;
export type EditArtifactStorageBackend = z.infer<
  typeof EditArtifactStorageBackendSchema
>;
export type PromptArtifactReviewSource = z.infer<
  typeof PromptArtifactReviewSourceSchema
>;
export type LiveGitReviewSource = z.infer<typeof LiveGitReviewSourceSchema>;
export type EditArtifactReviewSource = z.infer<
  typeof EditArtifactReviewSourceSchema
>;
export type EditArtifactDiffResponse = z.infer<
  typeof EditArtifactDiffResponseSchema
>;
