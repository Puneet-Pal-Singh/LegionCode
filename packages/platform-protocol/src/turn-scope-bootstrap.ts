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
});

export const TurnScopeBootstrapSchema = z.object({
  workspaceId: WorkspaceScopeIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
});

export type TurnScopeBootstrapRequest = z.infer<
  typeof TurnScopeBootstrapRequestSchema
>;
export type TurnScopeBootstrap = z.infer<typeof TurnScopeBootstrapSchema>;
