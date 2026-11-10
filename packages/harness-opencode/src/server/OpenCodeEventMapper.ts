import { sameNativePermissions } from "./OpenCodePermissionPolicy.js";
import { questionPayload } from "./OpenCodeQuestionMapper.js";
import { createHash } from "node:crypto";
import { OpenCodeEvent as NativeEventSchema } from "@opencode/protocol/groups/event";
import { Schema } from "effect";
import type {
  ModelRef,
  OpenCodeEvent,
  SessionCreateInput,
} from "@opencode/client";
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
  type HarnessRequestOrigin,
  type HarnessSession,
} from "@repo/worker-protocol";
import type { OpenCodeNativeRequestWithdrawal } from "./OpenCodePendingRequests.js";
import { OpenCodeTransportError } from "./OpenCodeClient.js";
import { OpenCodeUsageReader } from "./OpenCodeUsageReader.js";
import { openCodeFailure } from "./OpenCodeErrorMapper.js";

type Terminal = Extract<
  HarnessObservationPayload,
  { kind: "external_terminal" }
>;

type MappedRequest = Readonly<{
  requestType: "approval" | "user_input";
  requestId: string;
  itemId: ItemId;
  replyTo: HarnessRequestOrigin;
}>;

/** Native translation only. Host journals payloads; runtime validates and appends them. */
export class OpenCodeEventMapper {
  private readonly tools = new Map<string, { name: string; called: boolean }>();
  private readonly rootText = new Map<string, string>();
  private readonly usage: OpenCodeUsageReader;
  private pendingTerminal: Terminal | undefined;
  private terminalDelivered = false;
  private rootExecutionActive = false;
  private usageSequence = 0;
  private readonly terminalIds = new Map<string, string>();
  private readonly terminalPositions = new Map<string, string>();
  private readonly requests = new Map<string, MappedRequest>();
  private readonly seenRequests = new Set<string>();

  constructor(
    private readonly options: {
      readonly selection: HarnessSelection;
      readonly session: HarnessSession;
      readonly model: ModelRef;
      readonly permissions: NonNullable<SessionCreateInput["permissions"]>;
      readonly priorThreadTokens: number;
    },
  ) {
    this.usage = new OpenCodeUsageReader(
      options.model,
      options.selection.modelId,
      options.priorThreadTokens,
    );
  }

  map(
    event: OpenCodeEvent,
    withdrawal?: OpenCodeNativeRequestWithdrawal,
  ): ReadonlyArray<HarnessObservationPayload> {
    try {
      const receipt = this.terminalReceipt(event);
      if (receipt?.duplicate) return [];
      if (this.terminalDelivered)
        throw new OpenCodeTransportError("observation after quiescence", true);
      const origin =
        event.type === "form.created"
          ? event.data.form.sessionID
          : "sessionID" in event.data
            ? event.data.sessionID
            : undefined;
      const translated = withdrawal
        ? [this.withdrawRequest(event, withdrawal)]
        : this.translate(event);
      const payloads = translated.map((payload) =>
        HarnessObservationPayloadSchema.parse(
          origin &&
            origin !== this.options.session.externalSessionId &&
            payload.kind !== "external_terminal" &&
            payload.kind !== "quiescence"
            ? { ...payload, background: true }
            : payload,
        ),
      );
      // Remember only successfully translated, validated evidence. Repeated
      // native delivery must not repeat state transitions or canonical payloads.
      if (receipt) {
        this.terminalIds.set(event.id, receipt.fingerprint);
        this.terminalPositions.set(receipt.position, receipt.fingerprint);
      }
      return payloads;
    } catch {
      throw new OpenCodeTransportError("event translation", true);
    }
  }

  private terminalReceipt(event: OpenCodeEvent):
    | {
        position: string;
        fingerprint: string;
        duplicate: boolean;
      }
    | undefined {
    if (
      event.type !== "session.execution.succeeded" &&
      event.type !== "session.execution.failed" &&
      event.type !== "session.execution.interrupted"
    )
      return undefined;
    if (
      !validNativeEvent(event) ||
      event.durable.aggregateID !== event.data.sessionID
    )
      throw new OpenCodeTransportError(
        "invalid native terminal identity",
        true,
      );
    const position = JSON.stringify([
      event.data.sessionID,
      event.durable.aggregateID,
      event.durable.seq,
      event.durable.version,
    ]);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(event, (_key, value: unknown) =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).sort(([a], [b]) =>
                  a < b ? -1 : a > b ? 1 : 0,
                ),
              )
            : value,
        ),
      )
      .digest("hex");
    const byId = this.terminalIds.get(event.id);
    const byPosition = this.terminalPositions.get(position);
    if (
      (byId !== undefined && byId !== fingerprint) ||
      (byPosition !== undefined && byPosition !== fingerprint)
    )
      throw new OpenCodeTransportError(
        "conflicting native terminal evidence",
        true,
      );
    const duplicate = byId === fingerprint && byPosition === fingerprint;
    if (!duplicate && this.terminalIds.size >= 1000)
      throw new OpenCodeTransportError("native terminal receipt bound", true);
    return { position, fingerprint, duplicate };
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
      evidence.observationIntegrity !== "complete" ||
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
    if (this.pendingTerminal.status === "completed" && this.tools.size) {
      throw new OpenCodeTransportError("unsettled tool observations", true);
    }
    this.terminalDelivered = true;
    // Descendant completion and host settlement must not rewrite foreground time.
    return { ...this.pendingTerminal };
  }

  private translate(
    event: OpenCodeEvent,
  ): ReadonlyArray<HarnessObservationPayload> {
    switch (event.type) {
      case "session.permissions":
        if (
          !sameNativePermissions(
            this.options.permissions,
            event.data.permissions,
          )
        )
          throw new OpenCodeTransportError("native policy changed", true);
        return [];
      case "session.execution.started":
        if (event.data.sessionID === this.options.session.externalSessionId) {
          if (
            this.rootExecutionActive ||
            (this.pendingTerminal &&
              this.pendingTerminal.status !== "completed")
          )
            throw new OpenCodeTransportError(
              "unexpected root execution transition",
              true,
            );
          // Native child/background wakeups can open another busy period for
          // this same admitted prompt. No prompt is resent or session resumed.
          this.rootExecutionActive = true;
          this.pendingTerminal = undefined;
        }
        return [];
      case "session.moved":
        throw new OpenCodeTransportError("native workspace changed", true);
      case "session.model.selected":
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
        const key = this.toolKey(event.data);
        if (this.tools.size >= 1000 || this.tools.has(key))
          throw new OpenCodeTransportError(
            "tool observation bound or duplicate",
            true,
          );
        this.tools.set(key, { name: event.data.name, called: false });
        return [];
      }
      case "session.tool.called": {
        const key = this.toolKey(event.data);
        const tool = this.tools.get(key);
        if (!tool || tool.called)
          throw new OpenCodeTransportError(
            "tool call without input start",
            true,
          );
        tool.called = true;
        return [
          {
            kind: "tool_started",
            itemId: this.item("tool", key),
            content: {
              toolCallId: ToolCallIdSchema.parse(
                `toolcall_${this.hash("tool", key)}`,
              ),
              toolName: tool.name,
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
        if (!this.tools.get(key)?.called)
          throw new OpenCodeTransportError("tool result without start", true);
        this.tools.delete(key);
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
        if (!this.tools.get(key)?.called)
          throw new OpenCodeTransportError("tool failure without start", true);
        this.tools.delete(key);
        return [
          {
            kind: "tool_failed",
            itemId: this.item("tool", key),
            failure: openCodeFailure(event.data.error, "command_failed"),
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
        if (!this.tools.get(key)?.called)
          throw new OpenCodeTransportError(
            "permission without observed tool call",
            true,
          );
        const requestId = event.data.id;
        const payload = HarnessObservationPayloadSchema.parse({
          kind: "approval_requested",
          parentItemId: this.item("tool", key),
          request: {
            approvalId: ApprovalIdSchema.parse(
              `appr_${this.hash("permission", requestId)}`,
            ),
            itemId: this.item("permission", requestId),
            question: event.data.message ?? `Allow ${event.data.action}?`,
            options: [
              { id: "allow_once", label: "Allow once", description: null },
              { id: "deny", label: "Deny", description: null },
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
        });
        if (payload.kind !== "approval_requested" || payload.request.itemId === null)
          throw new OpenCodeTransportError("permission mapping", true);
        this.rememberRequest({
          requestType: "approval",
          requestId: payload.request.approvalId,
          itemId: payload.request.itemId,
          replyTo: payload.replyTo,
        });
        return [payload];
      }
      case "form.created": {
        const form = event.data.form;
        const payload = HarnessObservationPayloadSchema.parse({
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
        });
        if (payload.kind !== "user_input_requested")
          throw new OpenCodeTransportError("question mapping", true);
        this.rememberRequest({
          requestType: "user_input",
          requestId: payload.requestId,
          itemId: payload.itemId,
          replyTo: payload.replyTo,
        });
        return [payload];
      }
      case "permission.replied":
        this.completeRequest(
          "approval",
          event.data.sessionID,
          event.data.requestID,
        );
        return [];
      case "form.replied":
      case "form.cancelled":
        this.completeRequest("user_input", event.data.sessionID, event.data.id);
        return [];
      case "session.usage.updated": {
        const usage = this.usage.observe(event);
        return [
          {
            kind: "activity_measurement",
            measurement: this.usage.measurement({
              usage,
              selection: this.options.selection,
              session: this.options.session,
              measurementId: `opencode_usage_${this.hash("usage", event.id)}`,
              sequence: ++this.usageSequence,
              observedAt: new Date(event.created).toISOString(),
            }),
          },
          { kind: "usage", usage },
        ];
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (event.data.sessionID !== this.options.session.externalSessionId)
          return [];
        if (this.pendingTerminal || !this.rootExecutionActive)
          throw new OpenCodeTransportError("duplicate native terminal", true);
        this.rootExecutionActive = false;
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
              ? openCodeFailure(event.data.error)
              : null,
        };
        return [];
      }
      default:
        return [];
    }
  }

  private rememberRequest(request: MappedRequest): void {
    const key = this.requestKey(request.requestType, request.replyTo.requestId);
    if (
      this.requests.size >= 128 ||
      this.seenRequests.size >= 1000 ||
      this.seenRequests.has(key)
    )
      throw new OpenCodeTransportError(
        "canonical request mapping bound or duplicate",
        true,
      );
    this.seenRequests.add(key);
    this.requests.set(key, Object.freeze(structuredClone(request)));
  }

  private requireRequest(
    requestType: MappedRequest["requestType"],
    sessionID: string,
    nativeRequestID: string,
  ): MappedRequest {
    const request = this.requests.get(
      this.requestKey(requestType, nativeRequestID),
    );
    const expected = this.options.session;
    if (
      !request ||
      request.requestType !== requestType ||
      request.replyTo.origin !== sessionID ||
      request.replyTo.requestId !== nativeRequestID ||
      request.replyTo.authOwnerGeneration !==
        this.options.selection.authOwnerGeneration ||
      request.replyTo.session.runAttemptId !== expected.runAttemptId ||
      request.replyTo.session.instanceId !== expected.instanceId ||
      request.replyTo.session.externalSessionId !==
        expected.externalSessionId ||
      request.replyTo.session.processGeneration !== expected.processGeneration
    )
      throw new OpenCodeTransportError(
        "native request mapping scope changed",
        true,
      );
    return request;
  }

  private completeRequest(
    requestType: MappedRequest["requestType"],
    sessionID: string,
    nativeRequestID: string,
  ): void {
    this.requireRequest(requestType, sessionID, nativeRequestID);
    this.requests.delete(this.requestKey(requestType, nativeRequestID));
  }

  private withdrawRequest(
    event: OpenCodeEvent,
    withdrawal: OpenCodeNativeRequestWithdrawal,
  ): HarnessObservationPayload {
    const permission =
      withdrawal.requestType === "approval" &&
      event.type === "permission.replied" &&
      event.data.reply === "reject" &&
      event.data.sessionID === withdrawal.sessionID &&
      event.data.requestID === withdrawal.requestID;
    const form =
      withdrawal.requestType === "user_input" &&
      withdrawal.reason === "native_cancelled" &&
      event.type === "form.cancelled" &&
      event.data.sessionID === withdrawal.sessionID &&
      event.data.id === withdrawal.requestID;
    if (!permission && !form)
      throw new OpenCodeTransportError(
        "withdrawal without matching native closure",
        true,
      );
    const request = this.requireRequest(
      withdrawal.requestType,
      withdrawal.sessionID,
      withdrawal.requestID,
    );
    const payload = HarnessObservationPayloadSchema.parse({
      kind: "request_withdrawn",
      // Verified closure drains a pre-existing request even after foreground
      // terminal evidence; it never authorizes new work or another target.
      background: true,
      requestType: request.requestType,
      requestId: request.requestId,
      itemId: request.itemId,
      replyTo: request.replyTo,
      reason: withdrawal.reason,
    });
    this.requests.delete(
      this.requestKey(withdrawal.requestType, withdrawal.requestID),
    );
    return payload;
  }

  private requestKey(
    requestType: MappedRequest["requestType"],
    nativeRequestID: string,
  ): string {
    return `${requestType}:${nativeRequestID}`;
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

const validNativeEvent = Schema.is(Schema.toEncoded(NativeEventSchema));
