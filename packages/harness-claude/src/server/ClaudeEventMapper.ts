import { ClaudeUsageReader } from "./ClaudeUsageReader.js";
import type { HarnessSelection } from "@repo/platform-protocol";
import { createHash } from "node:crypto";
import {
  ItemIdSchema,
  ToolCallIdSchema,
  JsonRecordSchema,
} from "@repo/platform-protocol";
import type {
  HarnessObservationPayload,
  HarnessSession,
} from "@repo/worker-protocol";
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

function identity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

/** Translation only. The host journals returned observations; runtime decides lifecycle. */
export class ClaudeEventMapper {
  private readonly startedTools = new Map<string, string>();
  private readonly completedTools = new Set<string>();
  private readonly requestedTools = new Map<
    string,
    { readonly name: string; readonly input: unknown }
  >();
  private readonly messages = new Map<string, string>();
  private readonly usage: ClaudeUsageReader;
  private lastAssistantItem: ReturnType<typeof ItemIdSchema.parse>;

  constructor(
    private readonly session: HarnessSession,
    selection: HarnessSelection,
  ) {
    this.usage = new ClaudeUsageReader(session, selection);
    this.lastAssistantItem = this.item("assistant:result");
  }

  toolItem(toolUseId: string) {
    return this.item(`tool:${toolUseId}`);
  }

  private item(native: string) {
    return ItemIdSchema.parse(
      `itm_${identity(`${this.session.externalSessionId}:${native}`)}`,
    );
  }

  toolStarted(
    toolUseId: string,
    name: string,
    input: unknown,
  ): HarnessObservationPayload[] {
    const validatedInput = JsonRecordSchema.parse(input);
    const fingerprint = identity(
      JSON.stringify({ name, input: validatedInput }),
    );
    const previous = this.startedTools.get(toolUseId);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        throw new Error("Claude tool identity payload changed");
      return [];
    }
    if (this.startedTools.size >= 4096)
      throw new Error("Claude tool observation limit exceeded");
    const observation: HarnessObservationPayload = {
      kind: "tool_started",
      itemId: this.item(`tool:${toolUseId}`),
      content: {
        toolCallId: ToolCallIdSchema.parse(
          `toolcall_${identity(`${this.session.runAttemptId}:${this.session.externalSessionId}:${toolUseId}`)}`,
        ),
        toolName: name,
        input: validatedInput,
      },
    };
    this.startedTools.set(toolUseId, fingerprint);
    return [observation];
  }

  map(message: SDKMessage, observedAt?: string): HarnessObservationPayload[] {
    if (message.session_id !== this.session.externalSessionId)
      throw new Error("Claude observation session changed");
    if (message.type === "result" || message.type === "rate_limit_event") {
      const usage = this.usage.read(message, observedAt);
      return [
        ...usage.measurements.map((measurement) => ({
          kind: "activity_measurement" as const,
          measurement,
        })),
        ...usage.notifications.map((notification) => ({
          kind: "provider_limit" as const,
          notification,
        })),
      ];
    }
    // Complete content blocks stream independently. Partial deltas are ignored so the
    // following complete block cannot append the same text a second time.
    if (message.type === "assistant") {
      if (message.error !== undefined) return [];
      const fingerprint = identity(JSON.stringify(message.message));
      const previous = this.messages.get(message.uuid);
      if (previous !== undefined) {
        if (previous !== fingerprint)
          throw new Error("Claude message identity payload changed");
        return [];
      }
      if (this.messages.size >= 4096)
        throw new Error("Claude message observation limit exceeded");
      this.messages.set(message.uuid, fingerprint);
      const observations: HarnessObservationPayload[] = [];
      const item = this.item(
        `assistant:${message.parent_tool_use_id ?? "root"}:${message.message.id}`,
      );
      if (message.parent_tool_use_id === null) this.lastAssistantItem = item;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text)
          observations.push({
            kind: "assistant_text",
            itemId: item,
            text: block.text,
          });
        // Tool starts come from mandatory PreToolUse with validated input. Retain
        // raw requests only to correlate failures denied by SDK validation before hooks.
        if (block.type === "tool_use") {
          if (this.requestedTools.size >= 4096)
            throw new Error("Claude pending tool limit exceeded");
          this.requestedTools.set(block.id, {
            name: block.name,
            input: block.input,
          });
        }
      }
      return observations;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      const observations: HarnessObservationPayload[] = [];
      for (const block of message.message.content) {
        if (
          block.type !== "tool_result" ||
          this.completedTools.has(block.tool_use_id)
        )
          continue;
        if (!this.startedTools.has(block.tool_use_id)) {
          const request = this.requestedTools.get(block.tool_use_id);
          if (!block.is_error || !request)
            throw new Error(
              "Claude successful tool result has no mandatory policy start",
            );
          observations.push(
            ...this.toolStarted(block.tool_use_id, request.name, request.input),
          );
        }
        this.requestedTools.delete(block.tool_use_id);
        if (block.is_error) {
          observations.push({
            kind: "tool_failed",
            itemId: this.item(`tool:${block.tool_use_id}`),
            failure: {
              code: "command_failed",
              message: "Claude reported a failed tool execution",
              retryable: false,
              correlationId: null,
              details: null,
            },
          });
          this.completedTools.add(block.tool_use_id);
          continue;
        }
        const output =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? []);
        observations.push({
          kind: "tool_completed",
          itemId: this.item(`tool:${block.tool_use_id}`),
          output,
        });
        this.completedTools.add(block.tool_use_id);
      }
      return observations;
    }
    return [];
  }

  /** Caller holds this evidence until child observations have drained. */
  terminal(
    message: SDKResultMessage,
    stopped: boolean,
    providerCompletedAt: string,
  ): HarnessObservationPayload {
    if (message.session_id !== this.session.externalSessionId)
      throw new Error("Claude terminal session changed");
    const failed = message.is_error || message.subtype !== "success";
    return {
      kind: "external_terminal",
      providerCompletedAt,
      status: stopped ? "interrupted" : failed ? "failed" : "completed",
      itemId: this.lastAssistantItem,
      output: message.subtype === "success" && !failed ? message.result : "",
      error: failed
        ? {
            code: "provider_unavailable",
            message: "Claude execution did not complete successfully",
            retryable: false,
            correlationId: null,
            details: null,
          }
        : null,
    };
  }
}
