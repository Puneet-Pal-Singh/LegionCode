import { RunIdSchema } from "@repo/platform-protocol";
import { z } from "zod";
import {
  ArtifactDownloadRequestSchema,
  ArtifactDownloadResponseSchema,
  ArtifactListRequestSchema,
  ArtifactListResponseSchema,
  ArtifactUploadRequestSchema,
  ArtifactUploadResponseSchema,
} from "./artifacts.js";
import {
  WorkerCapabilitiesRequestSchema,
  WorkerCapabilitySnapshotSchema,
  WorkerHealthRequestSchema,
  WorkerHealthResponseSchema,
} from "./capabilities.js";
import {
  CommandCancelRequestSchema,
  CommandCancelResponseSchema,
  CommandRunRequestSchema,
  CommandRunResponseSchema,
} from "./commands.js";
import {
  WorkerOperationNameSchema,
  WorkerProtocolVersionSchema,
  WorkerRequestIdSchema,
} from "./common.js";
import { WorkerProtocolErrorSchema } from "./errors.js";
import {
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileListRequestSchema,
  FileListResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  PatchApplyRequestSchema,
  PatchApplyResponseSchema,
} from "./files.js";
import {
  GitCommitRequestSchema,
  GitCommitResponseSchema,
  GitDiffRequestSchema,
  GitDiffResponseSchema,
  GitPushRequestSchema,
  GitPushResponseSchema,
  GitStageRequestSchema,
  GitStageResponseSchema,
  GitStatusRequestSchema,
  GitStatusResponseSchema,
} from "./git.js";
import {
  WorkspaceCloseRequestSchema,
  WorkspaceCloseResponseSchema,
  WorkspacePrepareRequestSchema,
  WorkspacePrepareResponseSchema,
  WorkspaceRevertRequestSchema,
  WorkspaceRevertResponseSchema,
  WorkspaceSnapshotRequestSchema,
  WorkspaceSnapshotResponseSchema,
} from "./workspaces.js";

const WorkerRequestBaseSchema = z.object({
  requestId: WorkerRequestIdSchema,
  protocolVersion: WorkerProtocolVersionSchema,
  runId: RunIdSchema,
});

const WorkerSuccessResponseBaseSchema = WorkerRequestBaseSchema.extend({
  ok: z.literal(true),
});

export const WorkerCapabilitiesRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("worker.capabilities"),
    payload: WorkerCapabilitiesRequestSchema,
  }).strict();

export const WorkerHealthRequestEnvelopeSchema = WorkerRequestBaseSchema.extend(
  {
    operation: z.literal("worker.health"),
    payload: WorkerHealthRequestSchema,
  },
).strict();

export const WorkspacePrepareRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("workspace.prepare"),
    payload: WorkspacePrepareRequestSchema,
  }).strict();

export const WorkspaceSnapshotRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("workspace.snapshot"),
    payload: WorkspaceSnapshotRequestSchema,
  }).strict();

export const WorkspaceRevertRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("workspace.revert"),
    payload: WorkspaceRevertRequestSchema,
  }).strict();

export const WorkspaceCloseRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("workspace.close"),
    payload: WorkspaceCloseRequestSchema,
  }).strict();

export const CommandRunRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("command.run"),
  payload: CommandRunRequestSchema,
}).strict();

export const CommandCancelRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("command.cancel"),
    payload: CommandCancelRequestSchema,
  }).strict();

export const FileReadRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("file.read"),
  payload: FileReadRequestSchema,
}).strict();

export const FileWriteRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("file.write"),
  payload: FileWriteRequestSchema,
}).strict();

export const PatchApplyRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("file.applyPatch"),
  payload: PatchApplyRequestSchema,
}).strict();

export const FileListRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("file.list"),
  payload: FileListRequestSchema,
}).strict();

export const GitStatusRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("git.status"),
  payload: GitStatusRequestSchema,
}).strict();

export const GitDiffRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("git.diff"),
  payload: GitDiffRequestSchema,
}).strict();

export const GitStageRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("git.stage"),
  payload: GitStageRequestSchema,
}).strict();

export const GitCommitRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("git.commit"),
  payload: GitCommitRequestSchema,
}).strict();

export const GitPushRequestEnvelopeSchema = WorkerRequestBaseSchema.extend({
  operation: z.literal("git.push"),
  payload: GitPushRequestSchema,
}).strict();

export const ArtifactUploadRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("artifact.upload"),
    payload: ArtifactUploadRequestSchema,
  }).strict();

export const ArtifactDownloadRequestEnvelopeSchema =
  WorkerRequestBaseSchema.extend({
    operation: z.literal("artifact.download"),
    payload: ArtifactDownloadRequestSchema,
  }).strict();

export const ArtifactListRequestEnvelopeSchema = WorkerRequestBaseSchema.extend(
  {
    operation: z.literal("artifact.list"),
    payload: ArtifactListRequestSchema,
  },
).strict();

export const WorkerProtocolRequestSchema = z
  .discriminatedUnion("operation", [
    WorkerCapabilitiesRequestEnvelopeSchema,
    WorkerHealthRequestEnvelopeSchema,
    WorkspacePrepareRequestEnvelopeSchema,
    WorkspaceSnapshotRequestEnvelopeSchema,
    WorkspaceRevertRequestEnvelopeSchema,
    WorkspaceCloseRequestEnvelopeSchema,
    CommandRunRequestEnvelopeSchema,
    CommandCancelRequestEnvelopeSchema,
    FileReadRequestEnvelopeSchema,
    FileWriteRequestEnvelopeSchema,
    PatchApplyRequestEnvelopeSchema,
    FileListRequestEnvelopeSchema,
    GitStatusRequestEnvelopeSchema,
    GitDiffRequestEnvelopeSchema,
    GitStageRequestEnvelopeSchema,
    GitCommitRequestEnvelopeSchema,
    GitPushRequestEnvelopeSchema,
    ArtifactUploadRequestEnvelopeSchema,
    ArtifactDownloadRequestEnvelopeSchema,
    ArtifactListRequestEnvelopeSchema,
  ])
  .superRefine((request, context) => {
    if (
      request.operation === "workspace.prepare" &&
      request.payload.manifest.runId !== request.runId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspace manifest runId must match request runId",
        path: ["payload", "manifest", "runId"],
      });
    }
  });
export type WorkerProtocolRequest = z.infer<typeof WorkerProtocolRequestSchema>;

export const WorkerCapabilitiesSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("worker.capabilities"),
    payload: WorkerCapabilitySnapshotSchema,
  }).strict();

export const WorkerHealthSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("worker.health"),
    payload: WorkerHealthResponseSchema,
  }).strict();

export const WorkspacePrepareSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("workspace.prepare"),
    payload: WorkspacePrepareResponseSchema,
  }).strict();

export const WorkspaceSnapshotSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("workspace.snapshot"),
    payload: WorkspaceSnapshotResponseSchema,
  }).strict();

export const WorkspaceRevertSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("workspace.revert"),
    payload: WorkspaceRevertResponseSchema,
  }).strict();

export const WorkspaceCloseSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("workspace.close"),
    payload: WorkspaceCloseResponseSchema,
  }).strict();

export const CommandRunSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("command.run"),
    payload: CommandRunResponseSchema,
  }).strict();

export const CommandCancelSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("command.cancel"),
    payload: CommandCancelResponseSchema,
  }).strict();

export const FileReadSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("file.read"),
    payload: FileReadResponseSchema,
  }).strict();

export const FileWriteSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("file.write"),
    payload: FileWriteResponseSchema,
  }).strict();

export const PatchApplySuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("file.applyPatch"),
    payload: PatchApplyResponseSchema,
  }).strict();

export const FileListSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("file.list"),
    payload: FileListResponseSchema,
  }).strict();

export const GitStatusSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("git.status"),
    payload: GitStatusResponseSchema,
  }).strict();

export const GitDiffSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("git.diff"),
    payload: GitDiffResponseSchema,
  }).strict();

export const GitStageSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("git.stage"),
    payload: GitStageResponseSchema,
  }).strict();

export const GitCommitSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("git.commit"),
    payload: GitCommitResponseSchema,
  }).strict();

export const GitPushSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("git.push"),
    payload: GitPushResponseSchema,
  }).strict();

export const ArtifactUploadSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("artifact.upload"),
    payload: ArtifactUploadResponseSchema,
  }).strict();

export const ArtifactDownloadSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("artifact.download"),
    payload: ArtifactDownloadResponseSchema,
  }).strict();

export const ArtifactListSuccessResponseSchema =
  WorkerSuccessResponseBaseSchema.extend({
    operation: z.literal("artifact.list"),
    payload: ArtifactListResponseSchema,
  }).strict();

export const WorkerProtocolSuccessResponseSchema = z.discriminatedUnion(
  "operation",
  [
    WorkerCapabilitiesSuccessResponseSchema,
    WorkerHealthSuccessResponseSchema,
    WorkspacePrepareSuccessResponseSchema,
    WorkspaceSnapshotSuccessResponseSchema,
    WorkspaceRevertSuccessResponseSchema,
    WorkspaceCloseSuccessResponseSchema,
    CommandRunSuccessResponseSchema,
    CommandCancelSuccessResponseSchema,
    FileReadSuccessResponseSchema,
    FileWriteSuccessResponseSchema,
    PatchApplySuccessResponseSchema,
    FileListSuccessResponseSchema,
    GitStatusSuccessResponseSchema,
    GitDiffSuccessResponseSchema,
    GitStageSuccessResponseSchema,
    GitCommitSuccessResponseSchema,
    GitPushSuccessResponseSchema,
    ArtifactUploadSuccessResponseSchema,
    ArtifactDownloadSuccessResponseSchema,
    ArtifactListSuccessResponseSchema,
  ],
);
export type WorkerProtocolSuccessResponse = z.infer<
  typeof WorkerProtocolSuccessResponseSchema
>;

export const WorkerProtocolErrorResponseSchema = WorkerRequestBaseSchema.extend(
  {
    operation: WorkerOperationNameSchema,
    ok: z.literal(false),
    error: WorkerProtocolErrorSchema,
  },
).strict();
export type WorkerProtocolErrorResponse = z.infer<
  typeof WorkerProtocolErrorResponseSchema
>;

export const WorkerProtocolResponseSchema = z.union([
  WorkerProtocolSuccessResponseSchema,
  WorkerProtocolErrorResponseSchema,
]);
export type WorkerProtocolResponse = z.infer<
  typeof WorkerProtocolResponseSchema
>;
