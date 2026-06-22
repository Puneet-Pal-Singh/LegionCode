import { z } from "zod";
import {
  EventSequenceSchema,
  JsonRecordSchema,
  ProtocolTimestampSchema,
} from "./common.js";
import {
  ArtifactIdSchema,
  ItemIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const ArtifactKindSchema = z.enum([
  "git_patch",
  "file_snapshot",
  "command_log",
  "diff",
  "screenshot",
  "browser_recording",
  "context_checkpoint",
  "workspace_snapshot",
  "final_report",
  "generated_file",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactPayloadBackendSchema = z.enum([
  "r2",
  "cloudflare_artifacts",
  "local_blob",
]);
export type ArtifactPayloadBackend = z.infer<
  typeof ArtifactPayloadBackendSchema
>;

export const ArtifactPayloadRefSchema = z
  .object({
    backend: ArtifactPayloadBackendSchema,
    objectKey: z.string().min(1).max(1_024),
    uri: z.string().min(1).max(2_048).nullable(),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().safe().nonnegative(),
    sha256: z.string().regex(SHA256_HEX_PATTERN),
  })
  .strict();
export type ArtifactPayloadRef = z.infer<typeof ArtifactPayloadRefSchema>;

export const ArtifactChangedFileSchema = z
  .object({
    path: z.string().min(1).max(2_048),
    status: z.enum([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "unchanged",
    ]),
    additions: z.number().int().safe().nonnegative().nullable(),
    deletions: z.number().int().safe().nonnegative().nullable(),
    previousPath: z.string().min(1).max(2_048).nullable(),
  })
  .strict();
export type ArtifactChangedFile = z.infer<typeof ArtifactChangedFileSchema>;

const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);

export const TurnWorkspaceSnapshotSchema = z
  .object({
    turnId: TurnIdSchema,
    snapshotKey: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/u),
    treeId: GitObjectIdSchema,
    headSha: GitObjectIdSchema,
    phase: z.enum(["start", "terminal"]),
    capturedAt: ProtocolTimestampSchema,
  })
  .strict();
export type TurnWorkspaceSnapshot = z.infer<typeof TurnWorkspaceSnapshotSchema>;

export const TurnDiffPayloadSchema = z
  .object({
    turnId: TurnIdSchema,
    startSnapshot: TurnWorkspaceSnapshotSchema,
    terminalSnapshot: TurnWorkspaceSnapshotSchema,
    files: z.array(ArtifactChangedFileSchema).max(2_000),
    patch: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startSnapshot.turnId !== value.turnId) {
      context.addIssue({
        code: "custom",
        message: "Start snapshot turn mismatch",
      });
    }
    if (value.terminalSnapshot.turnId !== value.turnId) {
      context.addIssue({
        code: "custom",
        message: "Terminal snapshot turn mismatch",
      });
    }
  });
export type TurnDiffPayload = z.infer<typeof TurnDiffPayloadSchema>;

export const ArtifactMetadataSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    itemId: ItemIdSchema.nullable(),
    kind: ArtifactKindSchema,
    label: z.string().min(1).max(240),
    payloadRef: ArtifactPayloadRefSchema,
    changedFiles: z.array(ArtifactChangedFileSchema).max(2_000),
    metadata: JsonRecordSchema,
    createdAt: ProtocolTimestampSchema,
    eventSequence: EventSequenceSchema,
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export function buildArtifactKindSqlList(): string {
  return buildSqlList(ArtifactKindSchema.options);
}

export function buildArtifactPayloadBackendSqlList(): string {
  return buildSqlList(ArtifactPayloadBackendSchema.options);
}

export function buildArtifactChangedFileStatusSqlList(): string {
  return buildSqlList(ArtifactChangedFileSchema.shape.status.options);
}

function buildSqlList(values: readonly string[]): string {
  return values.map(quoteSqlLiteral).join(", ");
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
