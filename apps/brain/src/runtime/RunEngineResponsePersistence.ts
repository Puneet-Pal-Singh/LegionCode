import type { TurnScopeBootstrap } from "@repo/platform-protocol";
import type { Env } from "../types/ai";

export interface PersistedAssistantMessageResult {
  assistantMessageId: string;
}

/** Assistant transcript and terminal status are committed by lifecycle appendBatch. */
export async function persistAssistantMessageFromRunResponse(
  _ctx: unknown,
  _env: Env,
  _sessionId: string,
  _runId: string,
  _correlationId: string,
  _response: Response,
  _identity: TurnScopeBootstrap,
): Promise<PersistedAssistantMessageResult | null> {
  return null;
}
