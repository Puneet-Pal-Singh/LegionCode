import {
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from "@repo/platform-protocol";
import { z } from "zod";

export const BrainWorkspaceIdSchema = z.string().uuid();

export const RunInterruptIdentitySchema = z.object({
  runId: RunIdSchema,
  workspaceId: BrainWorkspaceIdSchema,
  sessionId: z.string().trim().min(1),
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
});

export type RunInterruptIdentity = z.infer<typeof RunInterruptIdentitySchema>;
