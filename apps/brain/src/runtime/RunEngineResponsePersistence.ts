import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import {
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
  if (persistedOutput) {
    return;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/plain")) {
    return;
  }

  let assistantText = "";
  try {
    assistantText = (await response.clone().text()).trim();
  } catch (error) {
    console.warn(
      `[run/engine-runtime] ${correlationId}: Failed to capture assistant stream for history persistence`,
      error,
    );
    return;
  }

  if (!assistantText) {
    return;
  }

  const persistenceService = new PersistenceService(env);
  await persistenceService.persistUserMessage(sessionId, runId, {
    role: "assistant",
    content: assistantText,
  });
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
    const run = await runRepository.getById(runId);
    const outputContent = run?.output?.content?.trim();

    if (!outputContent) {
      return false;
    }

    const persistenceService = new PersistenceService(env);
    await persistenceService.persistUserMessage(sessionId, runId, {
      role: "assistant",
      content: outputContent,
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
