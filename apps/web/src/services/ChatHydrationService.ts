import type { Message } from "@ai-sdk/react";
import { convertConversationHistoryMessages } from "@legioncode/client-ui";
import {
  ConversationHistoryReadError,
  AppServerClientError,
  projectConversationHistoryMessages,
  readConversationHistory,
  type ConversationHistoryPage,
} from "@legioncode/sdk";
import type { ConversationHistoryMessage } from "@legioncode/sdk";
import { createHostedAppServerClient } from "./api/appServerClient";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";

interface HistoryPagePayload {
  messages: ConversationHistoryMessage[];
  nextCursor: string | null;
  snapshot: string;
}

export type HydrationStatus =
  | "readable"
  | "empty"
  | "partial"
  | "recovery-required"
  | "failed"
  | "cancelled";

export interface HydrationResult {
  status: HydrationStatus;
  messages: Message[];
  snapshot?: string;
  nextCursor?: string;
  error?: string;
}

export class ChatHydrationService {
  async hydrateMessages(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<HydrationResult> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    logClientEvent("chat/hydration-service", "started", { requestId, sessionId });

    try {
      const result = await readConversationHistory<ConversationHistoryMessage>(
        async (cursor, snapshot, pageSignal) =>
          this.fetchHistoryPage(sessionId, cursor, snapshot, pageSignal),
        { signal },
      );
      const displayRecords = projectConversationHistoryMessages(result.messages);
      const messages = convertConversationHistoryMessages(displayRecords);
      logClientEvent("chat/hydration-service", "completed", {
        requestId,
        sessionId,
        messageCount: messages.length,
        messageIds: summarizeServerMessages(result.messages),
        durationMs: Date.now() - startedAt,
      });
      return {
        status: messages.length || displayRecords.length ? "readable" : "empty",
        messages,
        snapshot: result.snapshot,
      };
    } catch (error) {
      const readError = error instanceof ConversationHistoryReadError
        ? error
        : new ConversationHistoryReadError(error instanceof Error ? error.message : String(error));
      const displayRecords = projectConversationHistoryMessages(
        readError.messages as ConversationHistoryMessage[],
      );
      const messages = convertConversationHistoryMessages(displayRecords);
      const cancelled = signal?.aborted || readError.message.includes("cancelled");
      const status: HydrationStatus = cancelled
        ? "cancelled"
        : messages.length || displayRecords.length
          ? "partial"
          : readError.message.startsWith("History fetch failed: 404")
            ? "recovery-required"
            : "failed";
      logClientWarning("chat/hydration-service", "failed", {
        requestId,
        sessionId,
        status,
        error: readError.message,
        durationMs: Date.now() - startedAt,
      });
      return {
        status,
        messages,
        ...(readError.snapshot ? { snapshot: readError.snapshot } : {}),
        error: cancelled ? undefined : readError.message,
      };
    }
  }

  private async fetchHistoryPage(
    sessionId: string,
    cursor: string | null,
    snapshot: string | null,
    signal?: AbortSignal,
  ): Promise<ConversationHistoryPage<ConversationHistoryMessage>> {
    const pageRequestId = crypto.randomUUID();
    logClientEvent("chat/history", "page-requested", {
      requestId: pageRequestId,
      sessionId,
      cursor,
      snapshot,
    });
    let page: HistoryPagePayload;
    try {
      page = await createHostedAppServerClient({ signal, timeoutMs: null, maxResponseBytes: null }).getConversationHistoryPage({
        session: sessionId, limit: 50,
        ...(cursor !== null ? { cursor } : {}),
        ...(snapshot !== null ? { snapshot } : {}),
      }) as HistoryPagePayload;
    } catch (error) {
      if (error instanceof AppServerClientError) {
        if (error.serverCode === "not_found") throw new Error("History fetch failed: 404 Conversation not found");
        if (error.serverCode === "server_unavailable") throw new Error("History fetch failed: 503 Conversation history is unavailable");
        if (error.code === "invalid_response") throw new Error("Invalid history format: response failed the shared contract");
      }
      throw error;
    }
    logClientEvent("chat/history", "page-received", {
      requestId: pageRequestId,
      sessionId,
      messageCount: page.messages.length,
      messageIds: summarizeServerMessages(page.messages),
      hasNextCursor: page.nextCursor !== null,
    });
    return page;
  }
}

function summarizeServerMessages(messages: ConversationHistoryMessage[]): string {
  return messages.map((message) => `${message.role}:${message.id ?? "missing"}`).join(",");
}
