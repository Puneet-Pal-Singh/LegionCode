import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { TranscriptMessageRecord } from "@repo/persistence";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type { MessageEmittedEvent, RunEvent } from "@repo/shared-types";
import {
  projectRunActivityTranscript,
  RunEventRepository,
  RunRepository,
  tagRuntimeStateSemantics,
} from "@shadowbox/execution-engine/runtime";
import { DomainError } from "../domain/errors";
import { PersistenceService } from "../services/PersistenceService";
import type { Env } from "../types/ai";

export interface PersistedAssistantMessageResult {
  assistantMessageId: string;
}

class RunPostExecutionPersistenceError extends DomainError {
  constructor(
    operation: string,
    cause: unknown,
    correlationId: string,
  ) {
    super(
      "RUN_POST_EXECUTION_PERSISTENCE_FAILED",
      "Run post-execution persistence failed",
      503,
      true,
      correlationId,
      {
        operation,
        cause: describePersistenceCause(cause),
      },
    );
  }
}

export async function persistAssistantMessageFromRunResponse(
  ctx: DurableObjectState,
  env: Env,
  sessionId: string,
  runId: string,
  correlationId: string,
  response: Response,
): Promise<PersistedAssistantMessageResult | null> {
  if (!response.ok) {
    return null;
  }

  const persistedOutput = await persistAssistantMessageFromRunOutput(
    ctx,
    env,
    sessionId,
    runId,
    correlationId,
  );
  await persistTerminalRunStatusFromRuntime(ctx, env, runId, correlationId);
  return persistedOutput
    ? toPersistedAssistantMessageResult(persistedOutput)
    : null;
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
  const runRepository = new RunRepository(runtimeState);
  const run = await runRepository.getById(runId);
  const status = mapRuntimeTerminalStatus(run?.status);
  if (!status) {
    return;
  }

  try {
    const persistenceService = new PersistenceService(env);
    await persistenceService.updateRunStatus(
      runId,
      status,
      run?.metadata?.startedAt,
      run?.metadata?.completedAt ?? new Date().toISOString(),
    );
  } catch (error) {
    throw new RunPostExecutionPersistenceError(
      "persistTerminalRunStatus",
      error,
      correlationId,
    );
  }
}

async function persistAssistantMessageFromRunOutput(
  ctx: DurableObjectState,
  env: Env,
  sessionId: string,
  runId: string,
  correlationId: string,
): Promise<TranscriptMessageRecord | null> {
  const runtimeState = tagRuntimeStateSemantics(
    ctx as unknown as LegacyDurableObjectState,
    "do",
  );
  const runRepository = new RunRepository(runtimeState);
  const runEventRepository = new RunEventRepository(runtimeState);
  const run = await runRepository.getById(runId);
  const outputContent = run?.output?.content?.trim();

  if (!outputContent) {
    if (requiresPersistedAssistantOutput(run?.status)) {
      throw new RunPostExecutionPersistenceError(
        "readCanonicalAssistantOutput",
        new Error(`Missing canonical assistant output for run ${runId}`),
        correlationId,
      );
    }
    return null;
  }

  try {
    const persistenceService = new PersistenceService(env);
    const events = await runEventRepository.getByRun(runId);
    return await persistenceService.persistAssistantTurn({
      sessionId,
      runId,
      text: outputContent,
      metadata: readTerminalAssistantMetadata(events),
      activity: projectRunActivityTranscript({
        runId,
        sessionId,
        events,
        terminalStatus: mapRuntimeActivityTerminalStatus(run?.status),
        terminalReason: readTerminalReason(run?.metadata?.error),
      }),
    });
  } catch (error) {
    throw new RunPostExecutionPersistenceError(
      "persistAssistantTurn",
      error,
      correlationId,
    );
  }
}

function readTerminalAssistantMetadata(
  events: Awaited<ReturnType<RunEventRepository["getByRun"]>>,
): Record<string, unknown> | undefined {
  const assistantEvents = events.filter(isAssistantMessageEvent);
  const latestMetadata = assistantEvents.at(-1)?.payload.metadata;
  return latestMetadata && Object.keys(latestMetadata).length > 0
    ? latestMetadata
    : undefined;
}

function isAssistantMessageEvent(
  event: RunEvent,
): event is MessageEmittedEvent {
  return (
    event.type === RUN_EVENT_TYPES.MESSAGE_EMITTED &&
    event.payload.role === "assistant"
  );
}

function mapRuntimeActivityTerminalStatus(
  status: string | null | undefined,
): "completed" | "paused" | "failed" | "cancelled" {
  switch (status) {
    case "PAUSED":
      return "paused";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "completed";
  }
}

function readTerminalReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toPersistedAssistantMessageResult(
  message: TranscriptMessageRecord,
): PersistedAssistantMessageResult {
  return { assistantMessageId: message.id };
}

function requiresPersistedAssistantOutput(
  status: string | null | undefined,
): boolean {
  return status === "COMPLETED" || status === "PAUSED" || status === "FAILED";
}

function describePersistenceCause(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown persistence error";
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
