import { z } from "zod";
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
const WorkspaceScopeIdSchema = z.string().uuid();

export const TurnScopeBootstrapRequestSchema = z.object({
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  workspaceId: WorkspaceScopeIdSchema,
  userId: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1),
  clientMessageId: z.string().trim().min(1).optional(),
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
