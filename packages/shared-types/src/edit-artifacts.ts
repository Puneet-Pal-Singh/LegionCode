import { z } from "zod";

export const EDIT_ARTIFACT_KINDS = ["git_patch", "file_snapshot"] as const;

export const EDIT_ARTIFACT_STATUSES = [
  "pending",
  "stored",
  "capture_failed",
  "restore_in_progress",
  "restored",
  "anchored",
  "discarded",
  "expired",
  "restore_failed",
  "requires_user_resolution",
] as const;

export const EDIT_ARTIFACT_EVENT_TYPES = [
  "capture_started",
  "r2_write_succeeded",
  "metadata_commit_succeeded",
  "capture_failed",
  "restore_attempted",
  "restored",
  "restore_failed",
  "requires_user_resolution",
  "anchored",
  "discarded",
  "expired",
] as const;

export const EditArtifactKindSchema = z.enum(EDIT_ARTIFACT_KINDS);
export const EditArtifactStatusSchema = z.enum(EDIT_ARTIFACT_STATUSES);
export const EditArtifactEventTypeSchema = z.enum(EDIT_ARTIFACT_EVENT_TYPES);

export const EditArtifactChangedFileSchema = z.object({
  path: z.string().min(1),
  status: z.string().min(1),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  isStaged: z.boolean().optional(),
});

export const EditArtifactRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  repoOwner: z.string().min(1).nullable(),
  repoName: z.string().min(1).nullable(),
  repoUrl: z.string().url().nullable(),
  branch: z.string().min(1).nullable(),
  baseCommitSha: z.string().min(1).nullable(),
  headCommitSha: z.string().min(1).nullable(),
  artifactKind: EditArtifactKindSchema,
  r2ObjectKey: z.string().min(1),
  contentType: z.string().min(1).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().min(1).nullable(),
  changedFileCount: z.number().int().nonnegative(),
  changedFiles: z.array(EditArtifactChangedFileSchema),
  status: EditArtifactStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const EditArtifactEventSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  runId: z.string().min(1),
  eventType: EditArtifactEventTypeSchema,
  message: z.string().min(1),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().min(1),
});

export const CreateEditArtifactInputSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  repoOwner: z.string().min(1).nullable(),
  repoName: z.string().min(1).nullable(),
  repoUrl: z.string().url().nullable(),
  branch: z.string().min(1).nullable(),
  baseCommitSha: z.string().min(1).nullable(),
  artifactKind: EditArtifactKindSchema,
  r2ObjectKey: z.string().min(1),
  changedFiles: z.array(EditArtifactChangedFileSchema),
  expiresAt: z.string().min(1),
});

export const EditArtifactPatchObjectMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string().min(1),
  userId: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  repoOwner: z.string().min(1).nullable(),
  repoName: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  baseCommitSha: z.string().min(1).nullable(),
  patchSha256: z.string().min(1),
  changedFiles: z.array(EditArtifactChangedFileSchema),
  capturedAt: z.string().min(1),
});

export type EditArtifactKind = z.infer<typeof EditArtifactKindSchema>;
export type EditArtifactStatus = z.infer<typeof EditArtifactStatusSchema>;
export type EditArtifactEventType = z.infer<typeof EditArtifactEventTypeSchema>;
export type EditArtifactChangedFile = z.infer<
  typeof EditArtifactChangedFileSchema
>;
export type EditArtifactRecord = z.infer<typeof EditArtifactRecordSchema>;
export type EditArtifactEvent = z.infer<typeof EditArtifactEventSchema>;
export type CreateEditArtifactInput = z.infer<
  typeof CreateEditArtifactInputSchema
>;
export type EditArtifactPatchObjectMetadata = z.infer<
  typeof EditArtifactPatchObjectMetadataSchema
>;
