import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type {
  LifecycleEvent,
  TurnScopeBootstrap,
} from "@repo/platform-protocol";
import {
  RunRepository,
  tagRuntimeStateSemantics,
} from "@shadowbox/execution-engine/runtime";
import { DomainError } from "../domain/errors";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";
import { PersistenceService } from "../services/PersistenceService";
import type { Env } from "../types/ai";

export interface PersistedAssistantMessageResult {
  assistantMessageId: string;
}

class RunPostExecutionPersistenceError extends DomainError {
  constructor(operation: string, cause: unknown, correlationId: string) {
    super(
      "RUN_POST_EXECUTION_PERSISTENCE_FAILED",
      "Run post-execution persistence failed",
      503,
      true,
      correlationId,
      { operation, cause: describePersistenceCause(cause) },
    );
  }
}

/**
 * Lifecycle is the source of truth for assistant transcript ordering. This
 * callback only settles the legacy run projection after runtime completion;
 * it never reconstructs or infers a turn from RunEvents/activity snapshots.
 */
export async function persistAssistantMessageFromRunResponse(
  ctx: DurableObjectState,
  env: Env,
  _sessionId: string,
  runId: string,
  correlationId: string,
  response: Response,
  _identity: TurnScopeBootstrap,
): Promise<PersistedAssistantMessageResult | null> {
  if (!response.ok) return null;
  await persistTerminalRunStatusFromRuntime(ctx, env, runId, correlationId);
  return null;
}

export async function persistAssistantMessageFromLifecycleEvent(
  env: Env,
  sessionId: string,
  runId: string,
  identity: TurnScopeBootstrap,
  event: LifecycleEvent,
): Promise<PersistedAssistantMessageResult | null> {
  if (event.type !== "assistant_message.delta") return null;
  const delta = event.payload.delta;
  if (typeof delta !== "string" || delta.length === 0) return null;

  return await persistAssistantMessageText(
    env,
    sessionId,
    runId,
    identity,
    delta,
  );
}

export async function persistAssistantMessageText(
  env: Env,
  sessionId: string,
  runId: string,
  identity: TurnScopeBootstrap,
  text: string,
  phase: "commentary" | "final_answer" = "final_answer",
): Promise<PersistedAssistantMessageResult | null> {
  if (!text) return null;

  try {
    const message = await new PersistenceService(env).persistAssistantTurn({
      sessionId,
      runId,
      turnId: identity.turnId,
      text,
      metadata: { canonicalIdentity: identity, phase },
    });
    return { assistantMessageId: message.id };
  } catch (error) {
    throw new RunPostExecutionPersistenceError(
      "persistAssistantMessageText",
      error,
      runId,
    );
  }
}

async function persistTerminalRunStatusFromRuntime(
  ctx: DurableObjectState,
  env: Env,
  runId: string,
  correlationId: string,
): Promise<void> {
  const runtimeState = tagRuntimeStateSemantics(
    ctx as unknown as LegacyDurableObjectState,
    "do",
  );
  const run = await new RunRepository(runtimeState).getById(runId);
  const status = mapRuntimeTerminalStatus(run?.status);
  if (!status) return;

  try {
    await new PersistenceService(env).updateRunStatus(
      runId,
      status,
      run?.metadata?.startedAt,
      run?.metadata?.completedAt ?? new Date().toISOString(),
    );
    console.log(
      formatDiagnosticLogLine("run/post-execution", "terminal-status-persisted", {
        correlationId,
        runId,
        persistedStatus: status,
      }),
    );
  } catch (error) {
    throw new RunPostExecutionPersistenceError(
      "persistTerminalRunStatus",
      error,
      correlationId,
    );
  }
}

function mapRuntimeTerminalStatus(
  status: string | null | undefined,
): "completed" | "paused" | "failed" | "cancelled" | null {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "PAUSED":
      return "paused";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return null;
  }
}

function describePersistenceCause(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown persistence error";
}
