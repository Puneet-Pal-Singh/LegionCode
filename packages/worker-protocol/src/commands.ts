import { z } from "zod";
import {
  DurationMsSchema,
  TimeoutMsSchema,
  WorkerEnvironmentSchema,
  WorkerRequestIdSchema,
  WorkspaceRelativePathSchema,
} from "./common.js";

export const CommandRunRequestSchema = z
  .object({
    argv: z.array(z.string().min(1).max(4_096)).min(1).max(256),
    cwd: WorkspaceRelativePathSchema.nullable(),
    env: WorkerEnvironmentSchema,
    stdin: z.string().max(1_000_000).nullable(),
    timeoutMs: TimeoutMsSchema.nullable(),
  })
  .strict();
export type CommandRunRequest = z.infer<typeof CommandRunRequestSchema>;

export const CommandRunResponseSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: DurationMsSchema,
    timedOut: z.boolean(),
    signal: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type CommandRunResponse = z.infer<typeof CommandRunResponseSchema>;

export const CommandCancelRequestSchema = z
  .object({
    commandRequestId: WorkerRequestIdSchema,
  })
  .strict();
export type CommandCancelRequest = z.infer<typeof CommandCancelRequestSchema>;

export const CommandCancelResponseSchema = z
  .object({
    commandRequestId: WorkerRequestIdSchema,
    cancelled: z.boolean(),
  })
  .strict();
export type CommandCancelResponse = z.infer<typeof CommandCancelResponseSchema>;
