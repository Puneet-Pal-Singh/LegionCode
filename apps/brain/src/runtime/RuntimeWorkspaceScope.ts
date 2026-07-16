import { z } from "zod";
import {
  RunInterruptIdentitySchema,
  type RunInterruptIdentity,
} from "./RunInterruptContract";
import type { Env } from "../types/ai";

const RUNTIME_WORKSPACE_ROOT_PREFIX = "/home/sandbox/runs";

export const RuntimeWorkspaceScopeResponseSchema =
  RunInterruptIdentitySchema.extend({
    root: z.string().min(1),
  });

export type RuntimeWorkspaceScopeResponse = z.infer<
  typeof RuntimeWorkspaceScopeResponseSchema
>;

export interface SecureExecutionWorkspaceScope {
  runId: string;
  runAttemptId: string;
  workspaceId: string;
  root: string;
}

export function canonicalRuntimeWorkspaceRoot(runId: string): string {
  return `${RUNTIME_WORKSPACE_ROOT_PREFIX}/${runId}`;
}

export function toRuntimeWorkspaceScope(
  identity: RunInterruptIdentity,
): RuntimeWorkspaceScopeResponse {
  return RuntimeWorkspaceScopeResponseSchema.parse({
    ...identity,
    root: canonicalRuntimeWorkspaceRoot(identity.runId),
  });
}

export function toSecureExecutionWorkspaceScope(
  input: Pick<
    RuntimeWorkspaceScopeResponse,
    "runId" | "runAttemptId" | "workspaceId" | "root"
  >,
): SecureExecutionWorkspaceScope {
  return {
    runId: input.runId,
    runAttemptId: input.runAttemptId,
    workspaceId: input.workspaceId,
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
