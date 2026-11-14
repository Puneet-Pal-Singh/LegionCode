import { z } from "zod";
import { RunAttemptIdSchema, RunIdSchema, ThreadIdSchema, TurnIdSchema, UserIdSchema, WorkspaceIdSchema } from "@repo/platform-protocol";

export const LocalTurnArtifactScopeSchema = z.object({
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
}).strict();
