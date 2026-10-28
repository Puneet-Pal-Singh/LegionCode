import { z } from "zod";
import { LifecycleEventSchema } from "./lifecycle.js";
import {
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from "./ids.js";

const SessionIdSchema = z.string().trim().min(1);
// Brain's authenticated workspace scope is currently a UUID. Keep this
// contract aligned with that existing server-owned scope until workspace
// storage migrates to the prefixed platform WorkspaceId.
export const WorkspaceScopeIdSchema = z.string().uuid();

export const TurnScopeBootstrapRequestSchema = z.object({
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  workspaceId: WorkspaceScopeIdSchema,
  userId: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1),
  clientMessageId: z.string().trim().min(1).optional(),
  /** Exact durable identity reserved by Brain before it is imported by a runtime DO. */
  admittedIdentity: z.lazy(() => TurnScopeBootstrapSchema).optional(),
  /** The latest terminal turn whose prompt this turn supersedes. */
  revisionOfTurnId: TurnIdSchema.optional(),
});

export const TurnScopeReadQuerySchema = z.object({
  runId: RunIdSchema,
  sessionId: z.string().trim().min(1),
});

export const TurnScopeBootstrapSchema = z.object({
  workspaceId: WorkspaceScopeIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  /** The latest terminal turn whose prompt this turn supersedes. */
  revisionOfTurnId: TurnIdSchema.optional(),
  /** The interrupted turn this admitted turn resumes, distinct from revision. */
  continuationOfTurnId: TurnIdSchema.optional(),
  /** Stable prompt identity at the root of the logical task. */
  originalPromptId: z.string().trim().min(1).max(200).optional(),
}).superRefine((value, context) => {
  if ((value.continuationOfTurnId === undefined) !== (value.originalPromptId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Continuation turn and original prompt identity must be supplied together.",
      path: ["originalPromptId"],
    });
  }
});

export const InterruptTurnIdentitySchema = z.object({
  runId: RunIdSchema,
  workspaceId: WorkspaceScopeIdSchema,
  sessionId: SessionIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
});

export const InterruptTurnRequestSchema = InterruptTurnIdentitySchema.extend({
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export type TurnScopeBootstrapRequest = z.infer<
  typeof TurnScopeBootstrapRequestSchema
>;
export type TurnScopeReadQuery = z.infer<typeof TurnScopeReadQuerySchema>;
export type TurnScopeBootstrap = z.infer<typeof TurnScopeBootstrapSchema>;
export type InterruptTurnIdentity = z.infer<
  typeof InterruptTurnIdentitySchema
>;
export type InterruptTurnRequest = z.infer<typeof InterruptTurnRequestSchema>;

export const InterruptTurnResponseSchema = z.object({
  runId: RunIdSchema,
  accepted: z.boolean(),
  status: z.enum(["interrupt_requested", "settled"]).nullable(),
  terminalEvent: LifecycleEventSchema.nullable().optional(),
}).strict();

export type InterruptTurnResponse = z.infer<typeof InterruptTurnResponseSchema>;
