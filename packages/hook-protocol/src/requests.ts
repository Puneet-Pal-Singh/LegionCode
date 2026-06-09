import { JsonRecordSchema } from "@repo/platform-protocol";
import { z } from "zod";
import { HookRuntimeContextSchema } from "./context.js";

const PromptAttachmentSchema = z
  .object({
    attachmentId: z.string().min(1).max(128),
    kind: z.enum(["file", "image", "artifact", "url", "text"]),
    label: z.string().min(1).max(240),
    metadata: JsonRecordSchema,
  })
  .strict();
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;

export const SessionStartSourceSchema = z.enum([
  "new_session",
  "resume",
  "reconnect",
  "run_attach",
]);
export type SessionStartSource = z.infer<typeof SessionStartSourceSchema>;

export const SessionStartRequestSchema = z
  .object({
    context: HookRuntimeContextSchema,
    source: SessionStartSourceSchema,
    initialWorkspaceManifestRef: z.string().min(1).max(2_048).nullable(),
    capabilityManifestRef: z.string().min(1).max(2_048),
  })
  .strict();
export type SessionStartRequest = z.infer<typeof SessionStartRequestSchema>;

export const UserPromptSubmitRequestSchema = z
  .object({
    context: HookRuntimeContextSchema,
    prompt: z.string().min(1).max(200_000),
    attachments: z.array(PromptAttachmentSchema).max(128),
    selectedFiles: z.array(z.string().min(1).max(2_048)).max(1_000),
    selectedMode: z.enum(["ask", "auto_edit", "review", "plan"]),
  })
  .strict();
export type UserPromptSubmitRequest = z.infer<
  typeof UserPromptSubmitRequestSchema
>;

export const PermissionRequestActionKindSchema = z.enum([
  "shell_command",
  "git_mutation",
  "network",
  "filesystem_write",
  "secret_access",
  "browser",
  "integration",
]);
export type PermissionRequestActionKind = z.infer<
  typeof PermissionRequestActionKindSchema
>;

export const PermissionRequestHookRequestSchema = z
  .object({
    context: HookRuntimeContextSchema,
    permissionRequestId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(200),
    actionKind: PermissionRequestActionKindSchema,
    requestedAction: JsonRecordSchema,
    policyDecision: z.enum(["allow", "ask", "deny"]),
    policyReason: z.string().min(1).max(2_000),
  })
  .strict();
export type PermissionRequestHookRequest = z.infer<
  typeof PermissionRequestHookRequestSchema
>;

export const StopReasonSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "approval_denied",
  "tool_error",
  "model_stopped",
  "unknown",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const StopRequestSchema = z
  .object({
    context: HookRuntimeContextSchema,
    stopReason: StopReasonSchema,
    latestRunSummaryRef: z.string().min(1).max(2_048).nullable(),
    changedFilesRef: z.string().min(1).max(2_048).nullable(),
    pendingApprovalsRef: z.string().min(1).max(2_048).nullable(),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(2_000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type StopRequest = z.infer<typeof StopRequestSchema>;

export type HookRequestByEventName = {
  SessionStart: SessionStartRequest;
  UserPromptSubmit: UserPromptSubmitRequest;
  PermissionRequest: PermissionRequestHookRequest;
  Stop: StopRequest;
};

export const HookRequestSchemaByEventName = {
  SessionStart: SessionStartRequestSchema,
  UserPromptSubmit: UserPromptSubmitRequestSchema,
  PermissionRequest: PermissionRequestHookRequestSchema,
  Stop: StopRequestSchema,
} as const;
