import { JsonRecordSchema } from "@repo/platform-protocol";
import { z } from "zod";

export const WorkerProtocolErrorCodeSchema = z.enum([
  "validation_failed",
  "worker_unavailable",
  "worker_degraded",
  "workspace_unavailable",
  "workspace_prepare_failed",
  "workspace_snapshot_failed",
  "workspace_revert_failed",
  "workspace_close_failed",
  "capability_unsupported",
  "path_denied",
  "file_not_found",
  "file_write_failed",
  "patch_apply_failed",
  "command_failed",
  "command_timed_out",
  "command_cancelled",
  "git_operation_failed",
  "artifact_not_found",
  "artifact_upload_failed",
  "artifact_download_failed",
  "internal_error",
]);
export type WorkerProtocolErrorCode = z.infer<
  typeof WorkerProtocolErrorCodeSchema
>;

export const WorkerProtocolErrorSchema = z
  .object({
    code: WorkerProtocolErrorCodeSchema,
    message: z.string().min(1).max(10_000),
    retryable: z.boolean(),
    correlationId: z.string().min(1).max(200).nullable(),
    details: JsonRecordSchema.nullable(),
  })
  .strict();
export type WorkerProtocolError = z.infer<typeof WorkerProtocolErrorSchema>;
