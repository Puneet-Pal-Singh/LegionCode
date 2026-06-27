import {
  ProtocolTimestampSchema,
  WorkspaceManifestSchema,
} from "@repo/platform-protocol";
import { z } from "zod";
import { Sha256Schema } from "./common.js";

export const WorkspacePrepareRequestSchema = z
  .object({
    manifest: WorkspaceManifestSchema,
  })
  .strict();
export type WorkspacePrepareRequest = z.infer<
  typeof WorkspacePrepareRequestSchema
>;

export const WorkspacePrepareResponseSchema = z
  .object({
    filesystemRoot: z.string().min(1).max(2_048),
    preparedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkspacePrepareResponse = z.infer<
  typeof WorkspacePrepareResponseSchema
>;

export const WorkspaceSnapshotRequestSchema = z.object({}).strict();
export type WorkspaceSnapshotRequest = z.infer<
  typeof WorkspaceSnapshotRequestSchema
>;

export const WorkspaceSnapshotResponseSchema = z
  .object({
    snapshotId: z.string().min(1).max(256),
    sha256: Sha256Schema,
    createdAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkspaceSnapshotResponse = z.infer<
  typeof WorkspaceSnapshotResponseSchema
>;

export const WorkspaceRevertRequestSchema = z
  .object({
    snapshotId: z.string().min(1).max(256),
  })
  .strict();
export type WorkspaceRevertRequest = z.infer<
  typeof WorkspaceRevertRequestSchema
>;

export const WorkspaceRevertResponseSchema = z
  .object({
    revertedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkspaceRevertResponse = z.infer<
  typeof WorkspaceRevertResponseSchema
>;

export const WorkspaceCloseRequestSchema = z.object({}).strict();
export type WorkspaceCloseRequest = z.infer<typeof WorkspaceCloseRequestSchema>;

export const WorkspaceCloseResponseSchema = z
  .object({
    closedAt: ProtocolTimestampSchema,
  })
  .strict();
export type WorkspaceCloseResponse = z.infer<
  typeof WorkspaceCloseResponseSchema
>;
