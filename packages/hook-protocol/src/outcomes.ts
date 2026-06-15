import { JsonRecordSchema } from "@repo/platform-protocol";
import { z } from "zod";
import { ModelContextAdditionSchema } from "./context.js";

const HookOutcomeBaseSchema = z
  .object({
    userVisibleMessage: z.string().min(1).max(2_000).nullable(),
    modelContextAdditions: z.array(ModelContextAdditionSchema).max(64),
    auditMetadata: JsonRecordSchema,
  })
  .strict();

export const HookCleanupResultSchema = z
  .object({
    status: z.enum(["completed", "failed", "skipped"]),
    message: z.string().min(1).max(2_000).nullable(),
    metadata: JsonRecordSchema,
  })
  .strict();
export type HookCleanupResult = z.infer<typeof HookCleanupResultSchema>;

export const SessionStartOutcomeSchema = HookOutcomeBaseSchema.extend({
  status: z.enum(["continue", "stop"]),
});
export type SessionStartOutcome = z.infer<typeof SessionStartOutcomeSchema>;

export const UserPromptSubmitOutcomeSchema = HookOutcomeBaseSchema.extend({
  status: z.enum(["continue", "block"]),
  normalizedPrompt: z.string().min(1).max(200_000).nullable(),
});
export type UserPromptSubmitOutcome = z.infer<
  typeof UserPromptSubmitOutcomeSchema
>;

export const PermissionRequestOutcomeSchema = HookOutcomeBaseSchema.extend({
  status: z.enum(["approve", "deny", "ask"]),
  decisionReason: z.string().min(1).max(2_000).nullable(),
});
export type PermissionRequestOutcome = z.infer<
  typeof PermissionRequestOutcomeSchema
>;

export const StopOutcomeSchema = HookOutcomeBaseSchema.extend({
  status: z.literal("continue"),
  finalMessagePatch: z.string().min(1).max(20_000).nullable(),
  cleanupResult: HookCleanupResultSchema.nullable(),
});
export type StopOutcome = z.infer<typeof StopOutcomeSchema>;

export type HookOutcome =
  | SessionStartOutcome
  | UserPromptSubmitOutcome
  | PermissionRequestOutcome
  | StopOutcome;

export type HookOutcomeByEventName = {
  SessionStart: SessionStartOutcome;
  UserPromptSubmit: UserPromptSubmitOutcome;
  PermissionRequest: PermissionRequestOutcome;
  Stop: StopOutcome;
};

export const HookOutcomeSchemaByEventName = {
  SessionStart: SessionStartOutcomeSchema,
  UserPromptSubmit: UserPromptSubmitOutcomeSchema,
  PermissionRequest: PermissionRequestOutcomeSchema,
  Stop: StopOutcomeSchema,
} as const;
