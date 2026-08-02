import { z } from "zod";

/**
 * Web-side response validator for the server-owned /turn/start contract.
 * This validates returned identity; it never creates or derives an identity.
 */
export const TurnScopeBootstrapSchema = z
  .object({
    workspaceId: z.string().uuid(),
    threadId: z.string().regex(/^thr_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/),
    turnId: z.string().regex(/^trn_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/),
    runAttemptId: z
      .string()
      .regex(/^attempt_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/),
  })
  .strict();

export const TurnScopeReadQuerySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    runId: z
      .string()
      .regex(/^run_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/),
  })
  .strict();

export type TurnScopeBootstrap = z.infer<typeof TurnScopeBootstrapSchema>;
