import { questionPayload } from "./OpenCodeQuestionMapper.js";
import { createHash } from "node:crypto";
import type { ModelRef, OpenCodeEvent } from "@opencode/client";
import {
  ApprovalIdSchema,
  ItemIdSchema,
  JsonRecordSchema,
  ToolCallIdSchema,
  type HarnessSelection,
  type ItemId,
} from "@repo/platform-protocol";
import {
  HarnessObservationPayloadSchema,
  HarnessQuiescenceSchema,
  type HarnessObservationPayload,
  type HarnessQuiescence,
  type HarnessSession,
} from "@repo/worker-protocol";
import { OpenCodeTransportError } from "./OpenCodeClient.js";
import { OpenCodeUsageReader } from "./OpenCodeUsageReader.js";

type Terminal = Extract<
  HarnessObservationPayload,
  { kind: "external_terminal" }
>;

/** Native translation only. Host journals payloads; runtime validates and appends them. */
export class OpenCodeEventMapper {
  private readonly toolNames = new Map<string, string>();
  private readonly rootText = new Map<string, string>();
  private readonly usage: OpenCodeUsageReader;
  private pendingTerminal: Terminal | undefined;
  private terminalDelivered = false;
  private latestProviderCompletion = 0;

  constructor(
    private readonly options: {
      readonly selection: HarnessSelection;
      readonly session: HarnessSession;
      readonly model: ModelRef;
      readonly priorThreadTokens: number;
    },
  ) {
    this.usage = new OpenCodeUsageReader(
      options.model,
      options.selection.modelId,
      options.priorThreadTokens,
    );
  }

  map(event: OpenCodeEvent): ReadonlyArray<HarnessObservationPayload> {
    if (this.terminalDelivered)
      throw new OpenCodeTransportError("observation after quiescence", true);
    try {
      return this.translate(event).map((payload) =>
        HarnessObservationPayloadSchema.parse(payload),
      );
    } catch {
      throw new OpenCodeTransportError("event translation", true);
    }
  }

  get foregroundEnded(): boolean {
    return this.pendingTerminal !== undefined;
  }

  /** Foreground completion is deferred while descendants/background work may still emit. */
  terminalAfterQuiescence(input: HarnessQuiescence): Terminal {
    const evidence = HarnessQuiescenceSchema.parse(input);
    const expected = this.options.session;
    if (
      evidence.status !== "quiescent" ||
      evidence.session.runAttemptId !== expected.runAttemptId ||
      evidence.session.instanceId !== expected.instanceId ||
      evidence.session.externalSessionId !== expected.externalSessionId ||
      evidence.session.processGeneration !== expected.processGeneration ||
      !this.pendingTerminal ||
      this.terminalDelivered
    ) {
      throw new OpenCodeTransportError(
        "terminal without matching quiescence",
        true,
      );
    }
    if (this.pendingTerminal.status === "completed" && this.toolNames.size) {
      throw new OpenCodeTransportError("unsettled tool observations", true);
    }
    this.terminalDelivered = true;
    return {
      ...this.pendingTerminal,
      providerCompletedAt: new Date(
        this.latestProviderCompletion,
      ).toISOString(),
    };
  }

  private translate(
    event: OpenCodeEvent,
  ): ReadonlyArray<HarnessObservationPayload> {
    switch (event.type) {
      case "session.execution.started":
        if (event.data.sessionID === this.options.session.externalSessionId)
          this.pendingTerminal = undefined;
        return [];
      case "session.step.started":
        if (
          event.data.model.id !== this.options.model.id ||
          event.data.model.providerID !== this.options.model.providerID ||
          event.data.model.variant !== this.options.model.variant
        ) {
          throw new OpenCodeTransportError("selected model changed", true);
        }
        return [];
      case "session.text.delta": {
        if (event.data.sessionID !== this.options.session.externalSessionId)
          return [];
        if (this.pendingTerminal)
          throw new OpenCodeTransportError("root text after terminal", true);
        const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
        const text = (this.rootText.get(key) ?? "") + event.data.delta;
        this.rememberText(key, text);
        return [
          {
            kind: "assistant_text",
            itemId: this.item("text", key),
            text: event.data.delta,
          },
        ];
      }
      case "session.text.ended": {
        if (event.data.sessionID !== this.options.session.externalSessionId)
          return [];
        if (this.pendingTerminal)
          throw new OpenCodeTransportError("root text after terminal", true);
        const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
        const previous = this.rootText.get(key) ?? "";
        if (!event.data.text.startsWith(previous))
          throw new OpenCodeTransportError("text continuity", true);
        this.rememberText(key, event.data.text);
        const remaining = event.data.text.slice(previous.length);
        return remaining
          ? [
              {
                kind: "assistant_text",
                itemId: this.item("text", key),
                text: remaining,
              },
            ]
          : [];
      }
      case "session.tool.input.started": {
        if (this.toolNames.size >= 1000)
          throw new OpenCodeTransportError("tool observation bound", true);
        this.toolNames.set(this.toolKey(event.data), event.data.name);
        return [];
      }
      case "session.tool.called": {
        const key = this.toolKey(event.data);
        const name = this.toolNames.get(key);
        if (!name)
          throw new OpenCodeTransportError(
            "tool call without input start",
            true,
          );
        return [
          {
            kind: "tool_started",
            itemId: this.item("tool", key),
            content: {
              toolCallId: ToolCallIdSchema.parse(
                `toolcall_${this.hash("tool", key)}`,
              ),
              toolName: name,
              input: JsonRecordSchema.parse(event.data.input),
            },
          },
        ];
      }
      case "session.tool.success": {
        if (event.data.content.some((part) => part.type !== "text"))
          throw new OpenCodeTransportError(
            "external media output unavailable",
            true,
          );
        const key = this.toolKey(event.data);
        if (!this.toolNames.has(key))
          throw new OpenCodeTransportError("tool result without start", true);
        this.toolNames.delete(key);
        return [
          {
            kind: "tool_completed",
            itemId: this.item("tool", key),
            output: event.data.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          },
        ];
      }
      case "session.tool.failed": {
        const key = this.toolKey(event.data);
        if (!this.toolNames.has(key))
          throw new OpenCodeTransportError("tool failure without start", true);
        this.toolNames.delete(key);
        return [
          {
            kind: "tool_failed",
            itemId: this.item("tool", key),
            failure: {
              code:
                event.data.error.type === "permission.rejected"
                  ? "policy_denied"
                  : "command_failed",
              message:
                event.data.error.type === "permission.rejected"
                  ? "OpenCode action was denied."
                  : "OpenCode tool failed.",
              retryable: false,
              correlationId: null,
              details: null,
            },
          },
        ];
      }
      case "permission.asked": {
        if (!event.data.source || event.data.source.type !== "tool")
          throw new OpenCodeTransportError(
            "permission without tool origin",
            true,
          );
        const key = this.toolKey({
          sessionID: event.data.sessionID,
          assistantMessageID: event.data.source.messageID,
          id: event.data.source.id,
        });
        const requestId = event.data.id;
        return [
          {
            kind: "approval_requested",
            parentItemId: this.item("tool", key),
            request: {
              approvalId: ApprovalIdSchema.parse(
                `appr_${this.hash("permission", requestId)}`,
              ),
              itemId: this.item("permission", requestId),
              question: event.data.message ?? `Allow ${event.data.action}?`,
              options: [
                { id: "once", label: "Allow once", description: null },
                { id: "reject", label: "Deny", description: null },
              ],
              metadata: {
                action: event.data.action,
                resources: event.data.resources,
                externalSessionId: event.data.sessionID,
              },
            },
            replyTo: {
              session: this.options.session,
              origin: event.data.sessionID,
              requestId,
              authOwnerGeneration: this.options.selection.authOwnerGeneration,
            },
          },
        ];
      }
      case "form.created": {
        const form = event.data.form;
        return [
          {
            kind: "user_input_requested",
            itemId: this.item("question", form.id),
            requestId: `input_${this.hash("question", form.id)}`,
            payload: questionPayload(form),
            replyTo: {
              session: this.options.session,
              origin: form.sessionID,
              requestId: form.id,
              authOwnerGeneration: this.options.selection.authOwnerGeneration,
            },
          },
        ];
      }
      case "session.usage.updated":
        return [{ kind: "usage", usage: this.usage.observe(event) }];
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.latestProviderCompletion = Math.max(
          this.latestProviderCompletion,
          event.created,
        );
        if (event.data.sessionID !== this.options.session.externalSessionId)
          return [];
        if (this.pendingTerminal)
          throw new OpenCodeTransportError("duplicate native terminal", true);
        this.pendingTerminal = {
          kind: "external_terminal",
          providerCompletedAt: new Date(event.created).toISOString(),
          itemId: this.item("final", this.options.session.externalSessionId),
          status:
            event.type === "session.execution.succeeded"
              ? "completed"
              : event.type === "session.execution.failed"
                ? "failed"
                : "interrupted",
          output: [...this.rootText.values()].join("\n"),
          error:
            event.type === "session.execution.failed"
              ? {
                  code: "provider_unavailable",
                  message: "OpenCode execution failed.",
                  retryable: false,
                  correlationId: null,
                  details: null,
                }
              : null,
        };
        return [];
      }
      default:
        return [];
    }
  }

  private rememberText(key: string, text: string): void {
    this.rootText.set(key, text);
    if (
      this.rootText.size > 1000 ||
      [...this.rootText.values()].reduce(
        (size, value) => size + value.length,
        0,
      ) > 1_048_576
    ) {
      throw new OpenCodeTransportError("assistant output bound", true);
    }
  }

  private toolKey(data: {
    readonly sessionID: string;
    readonly assistantMessageID: string;
    readonly id: string;
  }): string {
    return JSON.stringify([data.sessionID, data.assistantMessageID, data.id]);
  }

  private hash(domain: string, externalId: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.options.session.runAttemptId,
          this.options.session.externalSessionId,
          domain,
          externalId,
        ]),
      )
      .digest("hex");
  }

  private item(domain: string, externalId: string): ItemId {
    return ItemIdSchema.parse(`itm_${this.hash(domain, externalId)}`);
  }
}
