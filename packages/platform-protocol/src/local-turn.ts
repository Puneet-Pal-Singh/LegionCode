import { z } from "zod";
import { RunSchema, ThreadItemSchema, TurnSchema } from "./conversation.js";
import {
  ModelIdSchema,
  ProviderIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { EventIdempotencyKeySchema } from "./events.js";

export const LocalTurnIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
}).strict();
export type LocalTurnIdentity = z.infer<typeof LocalTurnIdentitySchema>;

export const LocalTurnAdmissionSchema = z.object({
  identity: LocalTurnIdentitySchema,
  run: RunSchema,
  turn: TurnSchema,
  userMessage: ThreadItemSchema,
  providerId: ProviderIdSchema,
  modelId: ModelIdSchema,
  idempotencyKey: EventIdempotencyKeySchema,
}).strict().superRefine((admission, context) => {
  const { identity, run, turn, userMessage } = admission;
  if (run.id !== identity.runId) addIssue(context, ["run", "id"], "must match identity.runId");
  if (run.threadId !== identity.threadId) addIssue(context, ["run", "threadId"], "must match identity.threadId");
  if (run.workspaceId !== identity.workspaceId) addIssue(context, ["run", "workspaceId"], "must match identity.workspaceId");
  if (turn.id !== identity.turnId) addIssue(context, ["turn", "id"], "must match identity.turnId");
  if (turn.threadId !== identity.threadId) addIssue(context, ["turn", "threadId"], "must match identity.threadId");
  if (turn.runId !== identity.runId) addIssue(context, ["turn", "runId"], "must match identity.runId");
  if (userMessage.threadId !== identity.threadId) addIssue(context, ["userMessage", "threadId"], "must match identity.threadId");
  if (userMessage.runId !== identity.runId) addIssue(context, ["userMessage", "runId"], "must match identity.runId");
  if (userMessage.turnId !== identity.turnId) addIssue(context, ["userMessage", "turnId"], "must match identity.turnId");
  if (userMessage.type !== "user_message" || userMessage.role !== "user") addIssue(context, ["userMessage"], "must be a user message");
  if (userMessage.status !== "completed") addIssue(context, ["userMessage", "status"], "must be completed");
  if (run.status !== "running") addIssue(context, ["run", "status"], "must be running at admission");
  if (turn.status !== "running") addIssue(context, ["turn", "status"], "must be running at admission");
  if (run.providerId !== admission.providerId) addIssue(context, ["providerId"], "must match run.providerId");
  if (run.modelId !== admission.modelId) addIssue(context, ["modelId"], "must match run.modelId");
});
export type LocalTurnAdmission = z.infer<typeof LocalTurnAdmissionSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
