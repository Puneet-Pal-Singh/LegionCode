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
  private readonly messages = new Map<string, string>();
  private lastAssistantItem: ReturnType<typeof ItemIdSchema.parse>;

  constructor(private readonly session: HarnessSession) {
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

  map(message: SDKMessage): HarnessObservationPayload[] {
    if (message.session_id !== this.session.externalSessionId)
      throw new Error("Claude observation session changed");
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
        // Tool starts come from mandatory PreToolUse with the SDK's validated input,
        // rather than model-authored input that can still gain SDK defaults.
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
        if (!this.startedTools.has(block.tool_use_id))
          throw new Error("Claude tool result has no matching start");
        // P04 must add tool_failed before SDK tool errors can settle canonically.
        if (block.is_error)
          throw new Error(
            "Claude tool failed; canonical tool_failed observation is required",
          );
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
  ): HarnessObservationPayload {
    if (message.session_id !== this.session.externalSessionId)
      throw new Error("Claude terminal session changed");
    const failed = message.is_error || message.subtype !== "success";
    return {
      kind: "external_terminal",
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
