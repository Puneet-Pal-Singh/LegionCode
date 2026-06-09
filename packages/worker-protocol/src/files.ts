import { z } from "zod";
import {
  ByteCountSchema,
  Sha256Schema,
  WorkspaceRelativePathSchema,
} from "./common.js";

export const FileContentEncodingSchema = z.enum(["utf8", "base64"]);
export type FileContentEncoding = z.infer<
  typeof FileContentEncodingSchema
>;

export const FileReadRequestSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    encoding: FileContentEncodingSchema,
    maxBytes: ByteCountSchema.nullable(),
  })
  .strict();
export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;

export const FileReadResponseSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    encoding: FileContentEncodingSchema,
    content: z.string(),
    sizeBytes: ByteCountSchema,
    sha256: Sha256Schema,
    truncated: z.boolean(),
  })
  .strict();
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;

export const FileWriteRequestSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    encoding: FileContentEncodingSchema,
    content: z.string(),
    overwrite: z.boolean(),
    createParents: z.boolean(),
  })
  .strict();
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;

export const FileWriteResponseSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    sizeBytes: ByteCountSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type FileWriteResponse = z.infer<typeof FileWriteResponseSchema>;

export const PatchChangedFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export type PatchChangedFileStatus = z.infer<
  typeof PatchChangedFileStatusSchema
>;

export const PatchChangedFileSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    previousPath: WorkspaceRelativePathSchema.nullable(),
    status: PatchChangedFileStatusSchema,
  })
  .strict();
export type PatchChangedFile = z.infer<typeof PatchChangedFileSchema>;

export const PatchApplyRequestSchema = z
  .object({
    unifiedDiff: z.string().min(1).max(10_000_000),
    strip: z.number().int().min(0).max(16),
    reverse: z.boolean(),
    dryRun: z.boolean(),
  })
  .strict();
export type PatchApplyRequest = z.infer<typeof PatchApplyRequestSchema>;

export const PatchApplyResponseSchema = z
  .object({
    applied: z.boolean(),
    changedFiles: z.array(PatchChangedFileSchema).max(2_000),
    rejectedHunks: z.number().int().safe().nonnegative(),
  })
  .strict();
export type PatchApplyResponse = z.infer<typeof PatchApplyResponseSchema>;
