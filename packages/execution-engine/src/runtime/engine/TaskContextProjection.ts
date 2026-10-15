import type { CoreMessage } from "ai";

export interface TaskContextProjection {
  readonly messages: readonly CoreMessage[];
  readonly background: readonly CoreMessage[];
  readonly activeTask: readonly CoreMessage[];
  readonly activeTaskStartIndex: number;
}

/**
 * Keeps one logical task together when a provider request or compaction is
 * rebuilt. Callers can retain the original root prompt index while appending
 * accepted steering and tool progress to the same task.
 */
export function projectTaskContext(input: {
  readonly messages: readonly CoreMessage[];
  readonly activeTaskStartIndex?: number;
  readonly rootPromptId?: string;
}): TaskContextProjection {
  const startIndex = resolveTaskStartIndex(input);
  const messages = [...input.messages];
  return {
    messages,
    background: messages.slice(0, startIndex),
    activeTask: messages.slice(startIndex),
    activeTaskStartIndex: startIndex,
  };
}

/** Restore only complete, typed tool transcript parts persisted by Brain. */
export function restoreTaskToolMessage(input: {
  readonly role: string;
  readonly id: string;
  readonly parts: readonly { readonly type: string; readonly content: unknown }[];
}): CoreMessage | null {
  if (input.role !== "assistant" && input.role !== "tool") return null;
  const restored: unknown[] = [];
  let sawToolPart = false;
  for (const stored of input.parts) {
    if (stored.type === "raw") {
      if (!Array.isArray(stored.content) || stored.content.length === 0) return null;
      for (const value of stored.content) {
        const rawPart = asRecord(value);
        if (
          (input.role === "assistant" && rawPart?.type === "tool-call") ||
          (input.role === "tool" && rawPart?.type === "tool-result")
        ) {
          sawToolPart = true;
        }
        if (!restoreRawPart(value, input.role, restored)) return null;
      }
      continue;
    }
    const part = asRecord(stored.content);
    if (stored.type === "text" && input.role === "assistant") {
      const text = typeof stored.content === "string" ? stored.content : part?.text;
      if (typeof text === "string") restored.push({ type: "text", text });
      continue;
    }
    if (stored.type === "activity" || stored.type === "compaction_summary") continue;
    if (!part) return null;
    if (
      input.role === "assistant" &&
      stored.type === "tool_call" &&
      nonEmptyString(part.toolCallId) &&
      nonEmptyString(part.toolName) &&
      isRecord(part.input)
    ) {
      sawToolPart = true;
      restored.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.input,
      });
      continue;
    }
    if (
      input.role === "tool" &&
      stored.type === "tool_result" &&
      nonEmptyString(part.toolCallId) &&
      "result" in part &&
      (part.isError === undefined || typeof part.isError === "boolean")
    ) {
      sawToolPart = true;
      restored.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        ...(nonEmptyString(part.toolName) ? { toolName: part.toolName } : {}),
        result: part.result,
        ...(typeof part.isError === "boolean" ? { isError: part.isError } : {}),
      });
      continue;
    }
    return null;
  }
  if (!sawToolPart) return null;

  return {
    id: input.id,
    role: input.role,
    content: restored,
  } as CoreMessage;
}

/** Drops orphaned results and closes unrecorded calls before restored history is sent to a provider. */
export function normalizeTaskToolSequence(
  messages: readonly CoreMessage[],
): CoreMessage[] {
  const normalized: CoreMessage[] = [];
  let pending = new Map<string, { toolName: string; resultSeen: boolean }>();
  const closePending = () => {
    for (const [toolCallId, call] of pending) {
      if (call.resultSeen) continue;
      normalized.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName: call.toolName,
          result: {
            status: "unknown",
            message: "No tool result was recorded. Inspect workspace state before repeating this action.",
          },
          isError: true,
        }],
      } as CoreMessage);
    }
    pending = new Map();
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      closePending();
      if (!Array.isArray(message.content)) {
        normalized.push(message);
        continue;
      }
      const content = Array.isArray(message.content) ? message.content : [];
      const seenCallIds = new Set<string>();
      const calls: Array<{ toolCallId: string; toolName: string }> = [];
      const validContent = content.filter((part) => {
        if (!isRecord(part) || part.type !== "tool-call") return true;
        if (!nonEmptyString(part.toolCallId) || !nonEmptyString(part.toolName)) return false;
        if (seenCallIds.has(part.toolCallId)) return false;
        seenCallIds.add(part.toolCallId);
        calls.push({ toolCallId: part.toolCallId, toolName: part.toolName });
        return true;
      });
      pending = new Map(calls.map((call) => [call.toolCallId, { toolName: call.toolName, resultSeen: false }]));
      normalized.push({ ...message, content: validContent } as CoreMessage);
      continue;
    }
    if (message.role === "tool") {
      const content = Array.isArray(message.content) ? message.content : [];
      const results: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError?: boolean;
      }> = [];
      for (const part of content) {
        if (
          !isRecord(part) ||
          part.type !== "tool-result" ||
          !nonEmptyString(part.toolCallId) ||
          !("result" in part)
        ) continue;
        const call = pending.get(part.toolCallId);
        if (!call || call.resultSeen) continue;
        if (nonEmptyString(part.toolName) && part.toolName !== call.toolName) continue;
        call.resultSeen = true;
        results.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: call.toolName,
          result: part.result,
          ...(typeof part.isError === "boolean" ? { isError: part.isError } : {}),
        });
      }
      if (results.length > 0) normalized.push({ ...message, content: results } as CoreMessage);
      continue;
    }
    closePending();
    normalized.push(message);
  }
  closePending();
  return normalized;
}

function restoreRawPart(value: unknown, role: string, output: unknown[]): boolean {
  const part = asRecord(value);
  if (!part) return false;
  if (role === "assistant" && part.type === "text" && typeof part.text === "string") {
    output.push({ type: "text", text: part.text });
    return true;
  }
  if (
    role === "assistant" && part.type === "tool-call" &&
    nonEmptyString(part.toolCallId) && nonEmptyString(part.toolName) && isRecord(part.args)
  ) {
    output.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.args });
    return true;
  }
  if (
    role === "tool" && part.type === "tool-result" &&
    nonEmptyString(part.toolCallId) &&
    "result" in part &&
    (part.isError === undefined || typeof part.isError === "boolean")
  ) {
    output.push({
      type: "tool-result",
      toolCallId: part.toolCallId,
      ...(nonEmptyString(part.toolName) ? { toolName: part.toolName } : {}),
      result: part.result,
      ...(typeof part.isError === "boolean" ? { isError: part.isError } : {}),
    });
    return true;
  }
  return false;
}

function resolveTaskStartIndex(input: {
  readonly messages: readonly CoreMessage[];
  readonly activeTaskStartIndex?: number;
  readonly rootPromptId?: string;
}): number {
  if (input.rootPromptId) {
    const index = input.messages.findIndex(
      (message) =>
        (message as CoreMessage & { id?: string }).id === input.rootPromptId,
    );
    if (index < 0 || input.messages[index]?.role !== "user") {
      throw new Error("The logical task root prompt is missing from context.");
    }
    return index;
  }
  if (input.activeTaskStartIndex !== undefined) {
    const index = input.activeTaskStartIndex;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > input.messages.length ||
      (index < input.messages.length && input.messages[index]?.role !== "user")
    ) {
      throw new Error("The logical task root prompt index is invalid.");
    }
    return index;
  }
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") return index;
  }
  return input.messages.length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
