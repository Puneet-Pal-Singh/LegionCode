import { z } from "zod";
import { RunInterruptIdentitySchema } from "./RunInterruptContract";
import { workspaceIdFromExternalId } from "@repo/platform-protocol";
import type { Env } from "../types/ai";

export const RuntimeWorkspaceScopeResponseSchema =
  RunInterruptIdentitySchema.extend({
    root: z.string().min(1),
  });

export type RuntimeWorkspaceScopeResponse = z.infer<
  typeof RuntimeWorkspaceScopeResponseSchema
>;

export interface SecureExecutionWorkspaceScope {
  runId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  workspaceId: string;
  root: string;
}

export function toSecureExecutionWorkspaceScope(
  input: Pick<
    RuntimeWorkspaceScopeResponse,
    "runId" | "threadId" | "turnId" | "runAttemptId" | "workspaceId" | "root"
  >,
): SecureExecutionWorkspaceScope {
  return {
    runId: input.runId,
    threadId: input.threadId,
    turnId: input.turnId,
    runAttemptId: input.runAttemptId,
    workspaceId: workspaceIdFromExternalId(input.workspaceId),
    root: input.root,
  };
}

export async function fetchRunEngineWorkspaceScope(
  env: Env,
  runId: string,
): Promise<Response> {
  if (!env.RUN_ENGINE_RUNTIME) {
    throw new Error("RUN_ENGINE_RUNTIME binding is unavailable");
  }

  const id = env.RUN_ENGINE_RUNTIME.idFromName(runId);
  const stub = env.RUN_ENGINE_RUNTIME.get(id);
  return (await stub.fetch(
    `https://run-engine/scope?runId=${encodeURIComponent(runId)}`,
  )) as unknown as Response;
}
