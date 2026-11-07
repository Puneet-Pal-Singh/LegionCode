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

const PUBLIC_ERROR_MESSAGES = {
  validation_failed: "The request could not be validated.",
  unauthorized: "Authentication is required.",
  forbidden: "This operation is not permitted.",
  not_found: "The requested resource was not found.",
  conflict: "The request conflicts with the current state.",
  rate_limited: "The request is temporarily rate limited. Try again later.",
  provider_unavailable: "The model provider request failed.",
  model_unavailable: "The selected model is unavailable.",
  worker_unavailable: "The execution environment is unavailable.",
  workspace_prepare_failed: "The workspace could not be prepared.",
  command_failed: "The operation failed.",
  command_timed_out: "The operation timed out.",
  command_cancelled: "The operation was cancelled.",
  file_not_found: "The requested file was not found.",
  path_denied: "The requested path is not permitted.",
  artifact_upload_failed: "The artifact could not be saved.",
  git_command_failed: "The Git operation failed.",
  capability_unsupported: "This capability is unavailable.",
  tool_unavailable_in_backend: "This tool is unavailable in the selected environment.",
  policy_denied: "The operation was denied by policy.",
  approval_required: "Approval is required for this operation.",
  illegal_lifecycle_transition: "The operation conflicts with the current lifecycle state.",
  internal_error: "The request could not be completed.",
} satisfies Record<ProtocolErrorCode, string>;

const PublicClassificationSchema = z.object({
  code: ProtocolErrorCodeSchema,
  retryable: z.boolean().optional(),
});
const PublicErrorDetailsSchema = z.object({
  providerStatusCode: z.number().int().min(100).max(599).optional(),
  reason: z.literal("observation_integrity_lost").optional(),
});

/** Public error text is a contract, never a redacted upstream diagnostic.
 * The caller may supply its own correlation ID; an upstream ID is never adopted.
 * Neither validation as ProtocolError nor an Error subclass makes prose safe.
 */
export function toPublicProtocolError(
  input: unknown,
  fallback: Pick<ProtocolError, "code" | "retryable"> = {
    code: "internal_error",
    retryable: false,
  },
  trustedCorrelationId: string | null = null,
): ProtocolError {
  const classification = PublicClassificationSchema.safeParse(input);
  const code = classification.success ? classification.data.code : fallback.code;
  const retryable = classification.success
    ? classification.data.retryable ?? fallback.retryable
    : fallback.retryable;
  const details = PublicErrorDetailsSchema.safeParse(
    input !== null && typeof input === "object" && "details" in input
      ? input.details
      : null,
  );
  const publicDetails: NonNullable<ProtocolError["details"]> = {};
  if (details.success) {
    if (details.data.providerStatusCode !== undefined)
      publicDetails.providerStatusCode = details.data.providerStatusCode;
    if (details.data.reason !== undefined)
      publicDetails.reason = details.data.reason;
  }
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
    retryable,
    correlationId: trustedCorrelationId,
    details:
      Object.keys(publicDetails).length > 0
        ? publicDetails
        : null,
  };
}
