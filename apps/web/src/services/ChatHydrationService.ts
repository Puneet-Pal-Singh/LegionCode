import type { Message } from "@ai-sdk/react";
import {
  isTurnActivityTranscriptPart,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";
import { chatHistoryPath } from "../lib/platform-endpoints.js";
import { logClientEvent, logClientWarning } from "../lib/client-logger.js";

type ToolInvocation = NonNullable<Message["toolInvocations"]>[number];

interface ServerToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface CorePart {
  type: "text" | "tool-call";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
}

type ServerMessagePart =
  | CorePart
  | TurnActivityTranscriptPart
  | { type: string; [key: string]: unknown };

type MessageWithActivityData = Message & {
  data: {
    activityParts?: TurnActivityTranscriptPart[];
    metadata?: Record<string, unknown>;
  };
};

interface ServerMessage {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | ServerMessagePart[];
  tool_calls?: ServerToolCall[];
  createdAt?: string | Date;
  data?: {
    activityParts?: unknown[];
    metadata?: Record<string, unknown>;
  };
}

interface PaginatedHistoryResponse {
  messages: ServerMessage[];
  nextCursor?: string;
}

export interface HydrationResult {
  messages: Message[];
  error?: string;
}

export class ChatHydrationService {
  constructor() {}

  async hydrateMessages(
    sessionId: string,
    runId: string,
  ): Promise<HydrationResult> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    logClientEvent("chat/hydration-service", "started", {
      requestId,
      sessionId,
      runId,
    });
    try {
      const allMessages: ServerMessage[] = [];
      let cursor: string | undefined;
      const maxPages = 10; // Prevent infinite loops

      for (let page = 0; page < maxPages; page++) {
        const result = await this.fetchHistoryPage(
          sessionId,
          runId,
          cursor,
          50, // page size
        );

        if (result.error) {
          return { messages: [], error: result.error };
        }

        allMessages.push(...result.messages);

        if (!result.nextCursor) {
          break; // No more pages
        }

        cursor = result.nextCursor;
      }

      const messages = this.convertServerMessages(allMessages, runId);
      logClientEvent("chat/hydration-service", "completed", {
        requestId,
        runId,
        messageCount: messages.length,
        messageIds: summarizeServerMessages(allMessages),
        durationMs: Date.now() - startedAt,
      });
      return { messages };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logClientWarning("chat/hydration-service", "failed", {
        requestId,
        runId,
        error: errorMessage,
        durationMs: Date.now() - startedAt,
      });
      return { messages: [], error: errorMessage };
    }
  }

  private async fetchHistoryPage(
    sessionId: string,
    runId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<{
    messages: ServerMessage[];
    nextCursor?: string;
    error?: string;
  }> {
    const baseUrl = chatHistoryPath(runId);
    const url = new URL(baseUrl);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("limit", limit.toString());
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const pageRequestId = crypto.randomUUID();
    logClientEvent("chat/history", "page-requested", {
      requestId: pageRequestId,
      sessionId,
      runId,
      cursor: cursor ?? null,
      limit,
    });
    const res = await fetch(url.toString(), { credentials: "include" });

    if (!res.ok) {
      const errorPreview = await readResponsePreview(res);
      logClientWarning("chat/history", "page-failed", {
        requestId: pageRequestId,
        sessionId,
        runId,
        status: res.status,
        statusText: res.statusText,
        preview: errorPreview,
      });
      return {
        messages: [],
        error: `History fetch failed: ${res.status} ${res.statusText}`,
      };
    }

    const data: unknown = await res.json();

    // Handle paginated response format: { messages, nextCursor }
    if (
      data &&
      typeof data === "object" &&
      "messages" in data &&
      Array.isArray(data.messages)
    ) {
      const paginatedResponse = data as PaginatedHistoryResponse;
      logClientEvent("chat/history", "page-received", {
        requestId: pageRequestId,
        sessionId,
        runId,
        messageCount: paginatedResponse.messages.length,
        messageIds: summarizeServerMessages(paginatedResponse.messages),
        hasNextCursor: Boolean(paginatedResponse.nextCursor),
      });
      return {
        messages: paginatedResponse.messages,
        nextCursor: paginatedResponse.nextCursor,
      };
    }

    logClientWarning("chat/history", "page-invalid", {
      requestId: pageRequestId,
      sessionId,
      runId,
      payloadType: typeof data,
    });
    return { messages: [], error: "Invalid history format" };
  }

  private convertServerMessages(
    history: ServerMessage[],
    runId: string,
  ): Message[] {
    return history
      .filter((msg) => msg.role !== "tool")
      .map((msg, index) => {
        let content = "";
        let toolInvocations: ToolInvocation[] = [];
        const activityParts: TurnActivityTranscriptPart[] = readActivityData(
          msg.data,
        );
        const metadata = msg.data?.metadata;

        if (typeof msg.content === "string") {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Handle CoreMessage parts
          msg.content.forEach((part) => {
            if (isCoreTextPart(part)) {
              content += part.text;
            } else if (isToolCallPart(part)) {
              toolInvocations.push({
                state: "result",
                toolCallId: part.toolCallId || `${runId}-tool-${index}`,
                toolName: part.toolName || "unknown",
                args: part.args || {},
                result: null, // Results are pruned or handled separately
              });
            } else if (isTurnActivityTranscriptPart(part)) {
              activityParts.push(part);
            }
          });
        }

        const converted: Message = {
          id: msg.id || `${runId}-msg-${index}`,
          role: msg.role as "system" | "user" | "assistant",
          content,
          createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
        };

        // Handle legacy tool_calls format
        if (msg.role === "assistant" && msg.tool_calls) {
          const legacyTools = this.convertToolCalls(msg.tool_calls, runId);
          toolInvocations = [...toolInvocations, ...legacyTools];
        }

        if (toolInvocations.length > 0) {
          converted.toolInvocations = toolInvocations;
        }
        if (activityParts.length > 0 || metadata) {
          return attachMessageData(converted, {
            activityParts,
            metadata,
          });
        }

        return converted;
      });
  }

  private convertToolCalls(
    toolCalls: ServerToolCall[],
    runId: string,
  ): ToolInvocation[] {
    return toolCalls.map((tc, tcIndex) => ({
      state: "result" as const,
      toolCallId: tc.id || `${runId}-tool-${tcIndex}`,
      toolName: tc.function?.name || "unknown",
      args: this.parseToolArguments(tc.function?.arguments),
      result: null,
    }));
  }

  private parseToolArguments(
    args: string | undefined,
  ): Record<string, unknown> {
    if (!args) return {};
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function summarizeServerMessages(messages: ServerMessage[]): string {
  return messages
    .map((message) => `${message.role}:${message.id ?? "missing"}`)
    .join(",");
}

async function readResponsePreview(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 240);
  } catch {
    return "";
  }
}

function isCoreTextPart(
  value: ServerMessagePart,
): value is CorePart & { type: "text"; text: string } {
  return (
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string" &&
    value.text.length > 0
  );
}

function isToolCallPart(
  value: ServerMessagePart,
): value is CorePart & { type: "tool-call" } {
  return value.type === "tool-call";
}

function readActivityData(
  data: ServerMessage["data"],
): TurnActivityTranscriptPart[] {
  return (data?.activityParts ?? []).filter(isTurnActivityTranscriptPart);
}

function attachMessageData(
  message: Message,
  data: {
    activityParts: TurnActivityTranscriptPart[];
    metadata: Record<string, unknown> | undefined;
  },
): Message {
  const messageData = {
    ...(data.activityParts.length > 0
      ? { activityParts: data.activityParts }
      : {}),
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
  return {
    ...message,
    data: messageData,
  } as MessageWithActivityData;
}
