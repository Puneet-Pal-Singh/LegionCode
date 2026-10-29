import {
  ConversationHistoryResponseSchema,
  type ConversationHistoryMessage,
} from "@repo/platform-protocol";
import type { JsonValue } from "@repo/shared-types";

export type ConversationHistoryPartKind = "text" | "tool_call" | "tool_result" | "raw";

/** A source-preserving classification for display; it carries no execution state. */
export interface ConversationHistoryContentPart {
  kind: ConversationHistoryPartKind;
  source: JsonValue;
  inspectable?: boolean;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: JsonValue;
}

/** Keeps the exact protocol message and read order for a verified history snapshot. */
export interface ConversationHistoryDisplayRecord {
  sourceOrder: number;
  source: ConversationHistoryMessage;
  parts: ConversationHistoryContentPart[];
  inspectable: boolean;
}

/** Classifies source content once while retaining every original role and JSON value. */
export function projectConversationHistoryMessages(
  messages: readonly ConversationHistoryMessage[],
): ConversationHistoryDisplayRecord[] {
  return messages.map((source, sourceOrder) => {
    const parts = projectConversationHistoryContent(source);
    return {
      sourceOrder,
      source,
      parts,
      inspectable:
        parts.length === 0 ||
        (typeof source.content === "string" && source.content.length === 0) ||
        parts.some((part) => part.kind !== "text" || part.inspectable) ||
        Boolean(source.data?.metadata),
    };
  });
}

function projectConversationHistoryContent(
  message: ConversationHistoryMessage,
): ConversationHistoryContentPart[] {
  if (typeof message.content === "string") {
    const toolCallId = message.role === "tool" ? readToolCallId(message.content) : null;
    return [{
      kind: message.role === "tool" ? "tool_result" : "text",
      source: message.content,
      ...(toolCallId ? { toolCallId } : {}),
      ...(message.role !== "tool" ? { text: message.content } : {}),
    }];
  }
  return message.content.map((source) => projectConversationHistoryPart(source, message.role));
}

function projectConversationHistoryPart(
  source: JsonValue,
  role: ConversationHistoryMessage["role"],
): ConversationHistoryContentPart {
  if (!isRecord(source)) {
    return { kind: role === "tool" ? "tool_result" : "raw", source };
  }
  if (source.type === "text" && typeof source.text === "string") {
    const hasAdditionalFields = Object.keys(source).some((key) => key !== "type" && key !== "text");
    return {
      kind: "text",
      source,
      text: source.text,
      ...(hasAdditionalFields ? { inspectable: true } : {}),
    };
  }
  const functionValue = isRecord(source.function) ? source.function : null;
  const toolCall =
    source.type === "tool-call" ||
    source.type === "tool_use" ||
    source.type === "function_call" ||
    (source.type === "function" && functionValue !== null);
  if (toolCall) {
    const toolCallId = readString(source, "toolCallId") ?? readString(source, "id");
    const toolName =
      readString(source, "toolName") ??
      readString(source, "name") ??
      (functionValue ? readString(functionValue, "name") : null);
    const args = readToolArguments(source, functionValue);
    return {
      kind: "tool_call",
      source,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(args !== null ? { args } : {}),
    };
  }
  if (role === "tool" || source.type === "tool-result" || source.type === "tool_result") {
    const toolCallId =
      readString(source, "toolCallId") ??
      readString(source, "tool_call_id") ??
      readString(source, "callID");
    return { kind: "tool_result", source, ...(toolCallId ? { toolCallId } : {}) };
  }
  return { kind: "raw", source };
}

function readToolArguments(
  source: Record<string, JsonValue>,
  functionValue: Record<string, JsonValue> | null,
): JsonValue | null {
  const direct = source.args ?? source.input ?? source.arguments;
  if (direct !== undefined) {
    if (typeof direct === "string") {
      try {
        return JSON.parse(direct) as JsonValue;
      } catch {
        return null;
      }
    }
    return direct;
  }
  const nested = functionValue?.arguments;
  if (typeof nested === "string") {
    try {
      return JSON.parse(nested) as JsonValue;
    } catch {
      return null;
    }
  }
  return nested ?? null;
}

function readToolCallId(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed)
      ? readString(parsed, "tool_call_id") ?? readString(parsed, "toolCallId")
      : null;
  } catch {
    return null;
  }
}

function readString(value: Record<string, JsonValue>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Session transcript replay shared by clients. Cursor and snapshot are decimal
 * safe integers; cursors advance strictly and cannot cross the snapshot.
 */
export interface ConversationHistoryPage<TMessage> {
  messages: TMessage[];
  nextCursor: string | null;
  snapshot: string;
}

/** Validate an untrusted HTTP page against the shared protocol contract. */
export function parseConversationHistoryPage(value: unknown): ConversationHistoryPage<ConversationHistoryMessage> {
  const parsed = ConversationHistoryResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("History response failed the shared conversation-history contract");
  return parsed.data;
}

export interface ConversationHistoryReadOptions {
  signal?: AbortSignal;
  pageSize?: number;
}

export interface ConversationHistoryReadResult<TMessage> {
  messages: TMessage[];
  snapshot: string;
}

export class ConversationHistoryReadError extends Error {
  readonly messages: readonly unknown[];
  readonly snapshot: string | null;

  constructor(
    message: string,
    messages: readonly unknown[] = [],
    snapshot: string | null = null,
  ) {
    super(message);
    this.name = "ConversationHistoryReadError";
    this.messages = messages;
    this.snapshot = snapshot;
  }
}

export async function readConversationHistory<TMessage>(
  readPage: (
    cursor: string | null,
    snapshot: string | null,
    signal?: AbortSignal,
  ) => Promise<ConversationHistoryPage<TMessage>>,
  options: ConversationHistoryReadOptions = {},
): Promise<ConversationHistoryReadResult<TMessage>> {
  const messages: TMessage[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let snapshot: string | null = null;
  while (true) {
    if (options.signal?.aborted) {
      throw new ConversationHistoryReadError(
        "Conversation history read was cancelled",
        messages,
        snapshot,
      );
    }
    let page: ConversationHistoryPage<TMessage>;
    try {
      page = await readPage(cursor, snapshot, options.signal);
    } catch (error) {
      if (error instanceof ConversationHistoryReadError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConversationHistoryReadError(reason, messages, snapshot);
    }

    if (!page.snapshot || typeof page.snapshot !== "string") {
      throw new ConversationHistoryReadError(
        "History response is missing its snapshot watermark",
        messages,
        snapshot,
      );
    }
    const snapshotValue = Number(page.snapshot);
    if (!/^\d+$/.test(page.snapshot) || !Number.isSafeInteger(snapshotValue)) {
      throw new ConversationHistoryReadError(
        "History response contains an invalid snapshot watermark",
        messages,
        snapshot,
      );
    }
    if (snapshot !== null && page.snapshot !== snapshot) {
      throw new ConversationHistoryReadError(
        "History snapshot changed during pagination",
        messages,
        snapshot,
      );
    }
    snapshot ??= page.snapshot;
    if (!Array.isArray(page.messages)) {
      throw new ConversationHistoryReadError(
        "History response contains an invalid message page",
        messages,
        snapshot,
      );
    }
    if (page.nextCursor === null) {
      messages.push(...page.messages);
      return { messages, snapshot };
    }
    if (
      typeof page.nextCursor !== "string" ||
      page.nextCursor.length === 0 ||
      !/^\d+$/.test(page.nextCursor) ||
      !Number.isSafeInteger(Number(page.nextCursor)) ||
      Number(page.nextCursor) <= (cursor === null ? -1 : Number(cursor)) ||
      Number(page.nextCursor) > snapshotValue ||
      seenCursors.has(page.nextCursor) ||
      page.nextCursor === cursor
    ) {
      throw new ConversationHistoryReadError(
        "History pagination cursor did not make progress",
        messages,
        snapshot,
      );
    }
    messages.push(...page.messages);
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
