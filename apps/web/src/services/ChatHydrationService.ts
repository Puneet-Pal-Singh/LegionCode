import type { Message } from "@ai-sdk/react";
import {
  ConversationHistoryReadError,
  AppServerClientError,
  readConversationHistory,
  type ConversationHistoryPage,
} from "@legioncode/sdk";
import { createHostedAppServerClient } from "./api/appServerClient";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";

type ToolInvocation = NonNullable<Message["toolInvocations"]>[number];

interface CorePart {
  type: "text" | "tool-call";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
}

type ServerMessagePart = CorePart | { type: string; [key: string]: unknown };

type MessageWithMetadataData = Message & {
  data: { metadata?: Record<string, unknown> };
};

interface ServerMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | ServerMessagePart[];
  createdAt: string;
  data?: { metadata?: Record<string, unknown> };
}

interface HistoryPagePayload {
  messages: ServerMessage[];
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
      const result = await readConversationHistory<ServerMessage>(
        async (cursor, snapshot, pageSignal) =>
          this.fetchHistoryPage(sessionId, cursor, snapshot, pageSignal),
        { signal },
      );
      const messages = convertServerMessages(result.messages);
      logClientEvent("chat/hydration-service", "completed", {
        requestId,
        sessionId,
        messageCount: messages.length,
        messageIds: summarizeServerMessages(result.messages),
        durationMs: Date.now() - startedAt,
      });
      return {
        status: messages.length ? "readable" : "empty",
        messages,
        snapshot: result.snapshot,
      };
    } catch (error) {
      const readError = error instanceof ConversationHistoryReadError
        ? error
        : new ConversationHistoryReadError(error instanceof Error ? error.message : String(error));
      const messages = convertServerMessages(readError.messages as ServerMessage[]);
      const cancelled = signal?.aborted || readError.message.includes("cancelled");
      const status: HydrationStatus = cancelled
        ? "cancelled"
        : messages.length
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
  ): Promise<ConversationHistoryPage<ServerMessage>> {
    const pageRequestId = crypto.randomUUID();
    logClientEvent("chat/history", "page-requested", {
      requestId: pageRequestId,
      sessionId,
      cursor,
      snapshot,
    });
    let page: HistoryPagePayload;
    try {
      page = await createHostedAppServerClient({ signal, timeoutMs: null }).getConversationHistoryPage({
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

function convertServerMessages(history: ServerMessage[]): Message[] {
  return history
    .filter((msg) => msg.role !== "tool")
    .map((msg, index) => {
      let content = "";
      const toolInvocations: ToolInvocation[] = [];
      const metadata = msg.data?.metadata;

      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((part) => {
          if (isCoreTextPart(part)) {
            content += part.text;
          } else if (isToolCallPart(part)) {
            toolInvocations.push({
              state: "result",
              toolCallId: part.toolCallId || `history-tool-${index}`,
              toolName: part.toolName || "unknown",
              args: part.args || {},
              result: null,
            });
          }
        });
      }
      const converted: Message = {
        id: msg.id,
        role: msg.role as "system" | "user" | "assistant",
        content,
        createdAt: new Date(msg.createdAt),
      };
      if (toolInvocations.length > 0) converted.toolInvocations = toolInvocations;
      return metadata ? attachMessageData(converted, metadata) : converted;
    });
}

function summarizeServerMessages(messages: ServerMessage[]): string {
  return messages.map((message) => `${message.role}:${message.id ?? "missing"}`).join(",");
}

function isCoreTextPart(value: ServerMessagePart): value is CorePart & { type: "text"; text: string } {
  return value.type === "text" && "text" in value && typeof value.text === "string" && value.text.length > 0;
}

function isToolCallPart(value: ServerMessagePart): value is CorePart & { type: "tool-call" } {
  return value.type === "tool-call";
}

function attachMessageData(message: Message, metadata: Record<string, unknown>): Message {
  return { ...message, data: { metadata } } as MessageWithMetadataData;
}
