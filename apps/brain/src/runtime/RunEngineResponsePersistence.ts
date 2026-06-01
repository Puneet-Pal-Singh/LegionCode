import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type { MessageEmittedEvent, RunEvent } from "@repo/shared-types";
import {
  projectRunActivityTranscript,
  RunEventRepository,
  RunRepository,
  tagRuntimeStateSemantics,
} from "@shadowbox/execution-engine/runtime";
import { PersistenceService } from "../services/PersistenceService";
import type { Env } from "../types/ai";

export async function persistAssistantMessageFromRunResponse(
  ctx: DurableObjectState,
  env: Env,
  sessionId: string,
  runId: string,
  correlationId: string,
  response: Response,
): Promise<void> {
  if (!response.ok) {
    return;
  }

  const persistedOutput = await persistAssistantMessageFromRunOutput(
    ctx,
    env,
    sessionId,
    runId,
    correlationId,
  );
  await persistTerminalRunStatusFromRuntime(ctx, env, runId, correlationId);
  if (persistedOutput) {
    return;
  }

  await persistAssistantMessageFromTextResponse(
    env,
    sessionId,
    runId,
    correlationId,
    response,
  );
}

async function persistTerminalRunStatusFromRuntime(
  ctx: DurableObjectState,
  env: Env,
  runId: string,
  correlationId: string,
): Promise<void> {
  try {
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

    const persistenceService = new PersistenceService(env);
    await persistenceService.updateRunStatus(
      runId,
      status,
      run?.metadata?.startedAt,
      run?.metadata?.completedAt ?? new Date().toISOString(),
    );
  } catch (error) {
    console.warn(
      `[run/engine-runtime] ${correlationId}: Failed to persist terminal run status`,
      error,
    );
  }
}

async function persistAssistantMessageFromRunOutput(
  ctx: DurableObjectState,
  env: Env,
  sessionId: string,
  runId: string,
  correlationId: string,
): Promise<boolean> {
  try {
    const runtimeState = tagRuntimeStateSemantics(
      ctx as unknown as LegacyDurableObjectState,
      "do",
    );
    const runRepository = new RunRepository(runtimeState);
    const runEventRepository = new RunEventRepository(runtimeState);
    const run = await runRepository.getById(runId);
    const outputContent = run?.output?.content?.trim();

    if (!outputContent) {
      return false;
    }

    const persistenceService = new PersistenceService(env);
    const events = await runEventRepository.getByRun(runId);
    await persistenceService.persistAssistantTurn({
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
    return true;
  } catch (error) {
    console.warn(
      `[run/engine-runtime] ${correlationId}: Failed to persist assistant output from run state`,
      error,
    );
    return false;
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

async function persistAssistantMessageFromTextResponse(
  env: Env,
  sessionId: string,
  runId: string,
  correlationId: string,
  response: Response,
): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/plain")) {
    return;
  }

  try {
    const assistantText = (await response.clone().text()).trim();
    if (!assistantText) {
      return;
    }

    const persistenceService = new PersistenceService(env);
    await persistenceService.persistUserMessage(sessionId, runId, {
      role: "assistant",
      content: assistantText,
    });
  } catch (error) {
    console.warn(
      `[run/engine-runtime] ${correlationId}: Failed to capture assistant stream for history persistence`,
      error,
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
