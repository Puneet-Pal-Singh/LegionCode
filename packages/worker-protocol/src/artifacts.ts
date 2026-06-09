import {
  ArtifactIdSchema,
  JsonRecordSchema,
  RunIdSchema,
} from "@repo/platform-protocol";
import { z } from "zod";
import {
  ByteCountSchema,
  Sha256Schema,
  WorkspaceRelativePathSchema,
} from "./common.js";
import { FileContentEncodingSchema } from "./files.js";

export const WorkerArtifactKindSchema = z.enum([
  "diff",
  "patch",
  "command_log",
  "screenshot",
  "generated_file",
  "context_checkpoint",
  "workspace_snapshot",
  "final_report",
]);
export type WorkerArtifactKind = z.infer<typeof WorkerArtifactKindSchema>;

export const ArtifactUploadRequestSchema = z
  .object({
    runId: RunIdSchema,
    kind: WorkerArtifactKindSchema,
    contentType: z.string().min(1).max(255),
    encoding: FileContentEncodingSchema,
    content: z.string(),
    workspacePath: WorkspaceRelativePathSchema.nullable(),
    metadata: JsonRecordSchema,
  })
  .strict();
export type ArtifactUploadRequest = z.infer<
  typeof ArtifactUploadRequestSchema
>;

export const WorkerArtifactRefSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    kind: WorkerArtifactKindSchema,
    contentType: z.string().min(1).max(255),
    sizeBytes: ByteCountSchema,
    sha256: Sha256Schema,
    storageKey: z.string().min(1).max(1_024),
    workspacePath: WorkspaceRelativePathSchema.nullable(),
    metadata: JsonRecordSchema,
  })
  .strict();
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
    artifact: WorkerArtifactRefSchema,
    encoding: FileContentEncodingSchema,
    content: z.string(),
  })
  .strict();
export type ArtifactDownloadResponse = z.infer<
  typeof ArtifactDownloadResponseSchema
>;

export const ArtifactListRequestSchema = z
  .object({
    runId: RunIdSchema,
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
export type ArtifactListResponse = z.infer<
  typeof ArtifactListResponseSchema
>;
