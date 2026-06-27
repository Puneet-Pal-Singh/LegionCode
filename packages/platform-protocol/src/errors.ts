import { z } from "zod";
import { JsonRecordSchema } from "./common.js";

export const ProtocolErrorCodeSchema = z.enum([
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "provider_unavailable",
  "model_unavailable",
  "worker_unavailable",
  "workspace_prepare_failed",
  "command_failed",
  "command_timed_out",
  "command_cancelled",
  "file_not_found",
  "path_denied",
  "artifact_upload_failed",
  "git_command_failed",
  "capability_unsupported",
  "tool_unavailable_in_backend",
  "policy_denied",
  "approval_required",
  "illegal_lifecycle_transition",
  "internal_error",
]);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const ProtocolErrorSchema = z
  .object({
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1).max(10_000),
    retryable: z.boolean(),
    correlationId: z.string().min(1).max(200).nullable(),
    details: JsonRecordSchema.nullable(),
  })
  .strict();
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
