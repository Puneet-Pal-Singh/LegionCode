import {
  ArtifactKindSchema,
  ArtifactMetadataSchema,
} from "@repo/artifact-store";
import { ArtifactIdSchema, JsonRecordSchema } from "@repo/platform-protocol";
import { z } from "zod";
import { WorkspaceRelativePathSchema } from "./common.js";
import { FileContentEncodingSchema } from "./files.js";

export const WorkerArtifactKindSchema = ArtifactKindSchema;
export type WorkerArtifactKind = z.infer<typeof WorkerArtifactKindSchema>;

export const ArtifactUploadRequestSchema = z
  .object({
    kind: WorkerArtifactKindSchema,
    contentType: z.string().min(1).max(255),
    encoding: FileContentEncodingSchema,
    content: z.string(),
    workspacePath: WorkspaceRelativePathSchema.nullable(),
    properties: JsonRecordSchema,
  })
  .strict();
export type ArtifactUploadRequest = z.infer<typeof ArtifactUploadRequestSchema>;

export const WorkerArtifactRefSchema = ArtifactMetadataSchema;
export type WorkerArtifactRef = z.infer<typeof WorkerArtifactRefSchema>;

export const ArtifactUploadResponseSchema = WorkerArtifactRefSchema;
export type ArtifactUploadResponse = z.infer<
  typeof ArtifactUploadResponseSchema
>;

export const ArtifactDownloadRequestSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    encoding: FileContentEncodingSchema,
  })
  .strict();
export type ArtifactDownloadRequest = z.infer<
  typeof ArtifactDownloadRequestSchema
>;

export const ArtifactDownloadResponseSchema = z
  .object({
    artifact: ArtifactMetadataSchema,
    encoding: FileContentEncodingSchema,
    content: z.string(),
  })
  .strict();
export type ArtifactDownloadResponse = z.infer<
  typeof ArtifactDownloadResponseSchema
>;

export const ArtifactListRequestSchema = z
  .object({
    kinds: z.array(WorkerArtifactKindSchema).max(32),
    cursor: z.string().min(1).max(512).nullable(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export type ArtifactListRequest = z.infer<typeof ArtifactListRequestSchema>;

export const ArtifactListResponseSchema = z
  .object({
    artifacts: z.array(WorkerArtifactRefSchema).max(200),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;
