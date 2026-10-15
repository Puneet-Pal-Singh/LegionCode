import type { CoreMessage } from "ai";
import type { LifecycleEvent } from "@repo/platform-protocol";

export interface TaskContextProjection {
  readonly messages: readonly CoreMessage[];
  readonly background: readonly CoreMessage[];
  readonly activeTask: readonly CoreMessage[];
  readonly activeTaskStartIndex: number;
}

export interface LifecycleToolMessageGroup {
  readonly createdAt: string;
  readonly messages: readonly CoreMessage[];
  readonly mergeIntoMessageId?: string;
}

/** Rebuild canonical tool history without inferring names from display text. */
export function projectLifecycleToolMessages(
  events: readonly LifecycleEvent[],
  transcriptMessages: readonly CoreMessage[] = [],
): LifecycleToolMessageGroup[] {
  const transcriptCalls = new Map<string, string>();
  for (const message of transcriptMessages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const record = asRecord(part);
      if (record?.type === "tool-call" && nonEmptyString(record.toolCallId)) {
        transcriptCalls.set(record.toolCallId, readMessageId(message) ?? "");
      }
    }
  }
  const transcriptResults = readCompleteTaskToolCallIds(transcriptMessages);
  const calls = new Map<string, LifecycleToolCall>();
  for (const event of events) {
    if (
      !("toolCallId" in event) ||
      !event.toolCallId
    ) continue;
    const payload = asRecord(event.payload) ?? {};
    if (event.type === "tool_call.started") {
      const toolName = nonEmptyString(payload.toolName) ? payload.toolName : null;
      if (!toolName) continue;
      const prior = calls.get(event.toolCallId);
      calls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName,
        callBatchId: nonEmptyString(payload.callBatchId) ? payload.callBatchId : null,
        input: prior?.input ?? (isRecord(payload.input) ? payload.input : null),
        startedAt: event.createdAt,
        sequence: event.sequence,
        terminal: prior?.terminal ?? null,
      });
      continue;
    }
    const call = calls.get(event.toolCallId);
    if (!call) continue;
    if (event.type === "tool_call.input_delta" && isRecord(payload.input)) {
      call.input = payload.input;
    } else if (event.type === "tool_call.completed") {
      call.terminal = { result: payload.result, isError: false };
      if (!call.callBatchId && nonEmptyString(payload.callBatchId)) call.callBatchId = payload.callBatchId;
      if (nonEmptyString(payload.toolName)) call.toolName = payload.toolName;
    } else if (event.type === "tool_call.failed") {
      call.terminal = { result: { status: "failed", failure: payload.failure }, isError: true };
      if (!call.callBatchId && nonEmptyString(payload.callBatchId)) call.callBatchId = payload.callBatchId;
      if (nonEmptyString(payload.toolName)) call.toolName = payload.toolName;
    } else if (event.type === "tool_call.declined") {
      call.terminal = { result: { status: "denied", reason: payload.reason }, isError: true };
      if (!call.callBatchId && nonEmptyString(payload.callBatchId)) call.callBatchId = payload.callBatchId;
      if (nonEmptyString(payload.toolName)) call.toolName = payload.toolName;
    } else if (event.type === "tool_call.interrupted") {
      call.terminal = { result: { status: "interrupted", reason: payload.reason }, isError: true };
      if (!call.callBatchId && nonEmptyString(payload.callBatchId)) call.callBatchId = payload.callBatchId;
      if (nonEmptyString(payload.toolName)) call.toolName = payload.toolName;
    }
  }

  const batches = new Map<string, LifecycleToolCall[]>();
  for (const call of calls.values()) {
    if (!call.input && !transcriptCalls.has(call.toolCallId)) continue;
    const batchKey = call.callBatchId ?? call.toolCallId;
    const batch = batches.get(batchKey) ?? [];
    batch.push(call);
    batches.set(batchKey, batch);
  }
  return [...batches.entries()]
    .map<LifecycleToolMessageGroup | null>(([batchId, batch]) => {
      batch.sort((left, right) => left.sequence - right.sequence);
      const included = batch.filter((call) =>
        transcriptCalls.has(call.toolCallId)
          ? !transcriptResults.has(call.toolCallId)
          : !!call.input,
      );
      if (included.length === 0) return null;
      const mergeIntoMessageId = batch
        .map((call) => transcriptCalls.get(call.toolCallId))
        .find((messageId): messageId is string => !!messageId);
      const newCalls = included.filter(
        (call) => !transcriptCalls.has(call.toolCallId),
      );
      const newAssistant = newCalls.length > 0
        ? {
            id: `lifecycle-tool-calls:${batchId}`,
            role: "assistant",
            content: newCalls.map((call) => ({
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              args: call.input,
            })),
          } as CoreMessage
        : null;
      const tool: CoreMessage = {
        id: `lifecycle-tool-results:${batchId}`,
        role: "tool",
        content: included.map((call) => ({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: call.terminal ? call.terminal.result : {
            status: "unknown",
            message: "No terminal tool result was recorded. Inspect workspace state before repeating this action.",
          },
          ...(call.terminal?.isError ?? !call.terminal ? { isError: true } : {}),
        })),
      } as CoreMessage;
      if (mergeIntoMessageId) {
        return {
          createdAt: batch[0]!.startedAt,
          mergeIntoMessageId,
          messages: [...(newAssistant ? [newAssistant] : []), tool],
        };
      }
      const assistant: CoreMessage = {
        id: `lifecycle-tool-calls:${batchId}`,
        role: "assistant",
        content: included.map((call) => ({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.input,
        })),
      } as CoreMessage;
      return {
        createdAt: batch[0]!.startedAt,
        messages: [assistant, tool],
      };
    })
    .filter((group): group is LifecycleToolMessageGroup => group !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

interface LifecycleToolCall {
  toolCallId: string;
  toolName: string;
  callBatchId: string | null;
  input: Record<string, unknown> | null;
  startedAt: string;
  sequence: number;
  terminal: { result: unknown; isError: boolean } | null;
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
  options: {
    readonly synthesizeMissingResults?: boolean;
    readonly requireToolNameMatch?: boolean;
  } = {},
): CoreMessage[] {
  const normalized: CoreMessage[] = [];
  let pending = new Map<string, { toolName: string; resultSeen: boolean }>();
  const closePending = () => {
    for (const [toolCallId, call] of pending) {
      if (call.resultSeen) continue;
      if (options.synthesizeMissingResults === false) continue;
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
        if (
          (options.requireToolNameMatch && part.toolName !== call.toolName) ||
          (nonEmptyString(part.toolName) && part.toolName !== call.toolName)
        ) continue;
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

/** Return only transcript calls paired with a typed result in normal order. */
function readCompleteTaskToolCallIds(
  messages: readonly CoreMessage[],
): Set<string> {
  const normalized = normalizeTaskToolSequence(messages, {
    synthesizeMissingResults: false,
    requireToolNameMatch: true,
  });
  const results = new Set<string>();
  for (const message of normalized) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const record = asRecord(part);
      if (
        record?.type === "tool-result" &&
        nonEmptyString(record.toolCallId) &&
        "result" in record
      ) {
        results.add(record.toolCallId);
      }
    }
  }
  return results;
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

function readMessageId(message: CoreMessage): string | null {
  const id = (message as CoreMessage & { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
