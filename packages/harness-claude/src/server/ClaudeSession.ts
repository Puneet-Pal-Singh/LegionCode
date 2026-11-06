import { randomUUID } from "node:crypto";
import {
  HarnessHostError,
  ScopedRequestReply,
} from "@repo/harness-core/server";
import type {
  HarnessDriver,
  HarnessLiveSession,
} from "@repo/harness-core/server";
import {
  HarnessControlCommandSchema,
  HarnessSessionSchema,
  HarnessStartCommandSchema,
} from "@repo/worker-protocol";
import type {
  HarnessControlCommand,
  HarnessSession,
  HarnessObservationPayload,
  HarnessQuiescence,
  HarnessRequestOrigin,
} from "@repo/worker-protocol";
import type {
  HookCallback,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeQuestionRequests } from "./ClaudeQuestionMapper.js";
import { ClaudeEventMapper } from "./ClaudeEventMapper.js";
import { claudePermissionObservation } from "./ClaudePermissionMapper.js";
import { claudeProcessAdapter } from "./sdk/ClaudeProcessAdapter.js";
import { ClaudeQueryRunner } from "./sdk/ClaudeQueryRunner.js";

type Opening = Parameters<HarnessDriver["open"]>[0];
interface NativePermission {
  readonly reply: ScopedRequestReply<boolean>;
  readonly committed: Promise<void>;
  readonly cancel: () => void;
}

/** One admitted attempt's native handles. No canonical state store, event sequencer or lease owner. */
export class ClaudeSession implements HarnessLiveSession {
  readonly session: HarnessSession;
  private readonly mapper: ClaudeEventMapper;
  private readonly questions: ClaudeQuestionRequests;
  private interactionTail: Promise<unknown> = Promise.resolve();
  private pendingInteractions = 0;
  private readonly permissions = new Map<string, NativePermission>();
  private readonly fingerprint: string;
  private readonly promptId = randomUUID();
  private runner: ClaudeQueryRunner | undefined;
  private execution: Promise<void> | undefined;
  private stopped = false;
  private finished = false;
  private deliveryFailed = false;
  private foregroundTerminalStarted = false;
  private readonly stoppedSignal = new AbortController();

  constructor(private readonly opening: Opening) {
    this.session = HarnessSessionSchema.parse({
      runAttemptId: opening.command.selection.runAttemptId,
      instanceId: opening.command.selection.instanceId,
      externalSessionId: randomUUID(),
      processGeneration: opening.host.processGeneration,
    });
    this.mapper = new ClaudeEventMapper(
      this.session,
      opening.command.selection,
    );
    this.questions = new ClaudeQuestionRequests({
      session: this.session,
      authOwnerGeneration: opening.command.selection.authOwnerGeneration,
      active: () => !this.stopped && !this.finished,
      observe: (payload) => this.emit(payload),
    });
    this.fingerprint = JSON.stringify(opening.command);
  }

  execute(input: Parameters<HarnessLiveSession["execute"]>[0]): Promise<void> {
    const command = HarnessStartCommandSchema.parse(input.command);
    if (JSON.stringify(command) !== this.fingerprint)
      return Promise.reject(new HarnessHostError("stale_session"));
    if (this.execution) return this.execution;
    if (input.signal.aborted || this.opening.signal.aborted || this.stopped)
      return Promise.reject(new HarnessHostError("stale_session"));
    this.execution = this.run(input.signal);
    return this.execution;
  }

  async observeExisting(
    input: Parameters<HarnessLiveSession["observeExisting"]>[0],
  ): Promise<void> {
    if (input.signal.aborted || !this.execution)
      throw new HarnessHostError("stale_session");
    const abort = () => this.beginStop();
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      await this.execution;
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let result: SDKResultMessage | undefined;
    let backgroundFailure = false;
    let providerCompletedAt = new Date().toISOString();
    let observer: Promise<void> | undefined;
    const abort = () => this.beginStop();
    signal.addEventListener("abort", abort, { once: true });
    this.opening.signal.addEventListener("abort", abort, { once: true });
    try {
      const foreground = new Promise<SDKResultMessage>((resolve, reject) => {
        this.runner = new ClaudeQueryRunner({
          cwd: this.opening.host.workspaceRoot,
          instanceDirectory: this.opening.host.instanceDirectory,
          journalDirectory: this.opening.host.journalDirectory,
          env: this.opening.host.environment,
          model: this.opening.command.selection.modelId,
          sessionId: this.session.externalSessionId,
          // Mandatory policy lives in PreToolUse, including calls the SDK would auto-allow.
          beforeTool: this.beforeTool,
          canUseTool: async (name, input, origin) => {
            if (name === "AskUserQuestion")
              return this.interact(origin.signal, () =>
                this.questions.request(input, origin),
              );
            return {
              behavior: "deny",
              message: "No canonical grant for this native permission origin",
            };
          },
          spawnClaudeCodeProcess: claudeProcessAdapter(async (options) => {
            if (
              this.stopped ||
              options.signal.aborted ||
              options.cwd !== this.opening.host.workspaceRoot
            )
              throw new HarnessHostError("stale_session");
            const supervised = await this.opening.host.launch({
              executable: options.command,
              args: options.args,
            });
            await supervised.ready;
            return supervised.child;
          }, this.opening.host.environment),
        });
        observer = this.runner.observe(async (message) => {
          const observedAt = new Date().toISOString();
          if (
            "user_message_uuid" in message &&
            message.user_message_uuid !== undefined &&
            message.user_message_uuid !== this.promptId
          )
            throw new HarnessHostError("stale_session");
          for (const payload of this.mapper.map(message, observedAt))
            await this.emit(payload);
          if (message.type === "result") {
            if (result !== undefined) {
              // Native background completion can drive another root meta turn.
              // It stays in this admitted attempt; never accept another client UUID.
              backgroundFailure ||=
                message.is_error || message.subtype !== "success";
              return;
            }
            result = message;
            providerCompletedAt = observedAt;
            resolve(message);
          }
        });
        void observer.then(
          () => {
            if (!result) reject(new HarnessHostError("stale_session"));
          },
          () => reject(new HarnessHostError("stale_session")),
        );
      });
      // Rejection can precede startup completion; attach immediately, never replay input.
      void foreground.catch(() => undefined);
      await this.runner!.initialize();
      if (this.stopped || signal.aborted)
        throw new HarnessHostError("stale_session");
      this.runner!.submit({
        type: "user",
        message: { role: "user", content: this.opening.command.prompt },
        parent_tool_use_id: null,
        uuid: this.promptId,
        session_id: this.session.externalSessionId,
      });
      const terminalResult = await foreground;
      // Canonical ingress permits explicit background observations after this fact.
      // Keep the native query and approval/question callbacks alive for owned children.
      await this.emit(
        this.mapper.terminal(terminalResult, this.stopped, providerCompletedAt),
      );
      await this.runner!.awaitOwnedWork(this.stoppedSignal.signal);
      if (backgroundFailure) throw new HarnessHostError("stale_session");
      await this.runner!.stop();
      await this.opening.host.terminateProcesses({
        graceMs: 1000,
        killWaitMs: 1000,
      });
      if (observer) await this.withDeadline(observer, 2500);
      // All native observations drained. Runtime still requires independent OS evidence.
    } catch {
      const interrupted = this.stopped || signal.aborted;
      this.beginStop();
      await this.opening.host.terminateProcesses({
        graceMs: 1000,
        killWaitMs: 1000,
      });
      this.runner?.close();
      if (observer)
        await this.withDeadline(observer, 2500).catch(() => undefined);
      if (!this.deliveryFailed && !this.foregroundTerminalStarted) {
        await this.emit({
          kind: "external_terminal",
          providerCompletedAt: new Date().toISOString(),
          status: interrupted ? "interrupted" : "failed",
          itemId: this.mapper.toolItem("terminal"),
          output: "",
          error: {
            code: interrupted ? "command_cancelled" : "provider_unavailable",
            message: interrupted
              ? "Claude execution was interrupted"
              : "Claude execution or observation delivery failed",
            retryable: false,
            correlationId: null,
            details: null,
          },
        });
        return;
      }
      throw new HarnessHostError(
        this.deliveryFailed
          ? "journal_corrupt"
          : interrupted
            ? "stale_session"
            : "process_not_quiescent",
      );
    } finally {
      this.finished = true;
      this.runner?.close();
      this.cancelPermissions();
      signal.removeEventListener("abort", abort);
      this.opening.signal.removeEventListener("abort", abort);
    }
  }

  private readonly beforeTool: HookCallback = async (
    input,
    _toolUseId,
    context,
  ) => {
    if (
      input.hook_event_name !== "PreToolUse" ||
      this.stopped ||
      context.signal.aborted
    )
      return { continue: false, decision: "block" };
    for (const payload of this.mapper.toolStarted(
      input.tool_use_id,
      input.tool_name,
      input.tool_input,
    ))
      await this.emit(payload);
    if (input.tool_name === "AskUserQuestion")
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            "Question answers require the native scoped input callback",
        },
      };
    const replyTo: HarnessRequestOrigin = {
      session: this.session,
      origin: "claude.PreToolUse",
      requestId: input.tool_use_id,
      authOwnerGeneration: this.opening.command.selection.authOwnerGeneration,
    };
    const approved = await this.interact(context.signal, () =>
      this.ask(replyTo, input.tool_name, context.signal),
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: approved ? "allow" : "deny",
        permissionDecisionReason: "Canonical one-shot approval decision",
      },
    };
  };

  private async ask(
    origin: HarnessRequestOrigin,
    toolName: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      this.stopped ||
      signal.aborted ||
      this.permissions.has(origin.requestId) ||
      this.permissions.size >= 128
    )
      return false;
    let request: NativePermission | undefined;
    const approved = new Promise<boolean>((resolve) => {
      const reply = new ScopedRequestReply<boolean>(
        origin.requestId,
        origin.origin,
        this.opening.host.processGeneration,
        origin.authOwnerGeneration,
        async (value) => {
          resolve(value);
        },
        () => !this.stopped && !this.finished && !signal.aborted,
      );
      const cancel = () => {
        reply.fence();
        resolve(false);
      };
      const committed = Promise.resolve().then(() =>
        this.emit(
          claudePermissionObservation({
            replyTo: origin,
            parentItemId: this.mapper.toolItem(origin.requestId),
            toolName,
          }),
        ),
      );
      request = { reply, committed, cancel };
      this.permissions.set(origin.requestId, request);
      void committed.catch(cancel);
    });
    const abort = () => request?.cancel();
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await approved;
    } finally {
      signal.removeEventListener("abort", abort);
      this.permissions.delete(origin.requestId);
    }
  }

  async control(
    raw: HarnessControlCommand,
  ): Promise<{ readonly accepted: boolean }> {
    const command = HarnessControlCommandSchema.parse(raw);
    const session =
      command.kind === "reply" || command.kind === "user_input_reply"
        ? command.reply.replyTo.session
        : command.session;
    if (JSON.stringify(session) !== JSON.stringify(this.session))
      throw new HarnessHostError("stale_session");
    if (command.kind === "interrupt" || command.kind === "dispose") {
      this.beginStop();
      return { accepted: true };
    }
    if (command.kind === "steer") return { accepted: false };
    if (command.kind === "user_input_reply") {
      await this.questions.respond(command.reply);
      return { accepted: true };
    }
    const origin = command.reply.replyTo;
    if (
      this.stopped ||
      this.finished ||
      command.reply.grantScope !== undefined ||
      origin.authOwnerGeneration !==
        this.opening.command.selection.authOwnerGeneration
    )
      throw new HarnessHostError("request_unavailable");
    const request = this.permissions.get(origin.requestId);
    if (!request) throw new HarnessHostError("request_unavailable");
    await request.committed;
    await request.reply.reply({
      requestId: origin.requestId,
      origin: origin.origin,
      processGeneration: this.opening.host.processGeneration,
      authOwnerGeneration: origin.authOwnerGeneration,
      value: command.reply.decision === "approved",
    });
    return { accepted: true };
  }

  async awaitQuiescence(input: {
    readonly timeoutMs: number;
  }): Promise<HarnessQuiescence> {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 0 ||
      input.timeoutMs > 60_000
    )
      throw new HarnessHostError("invalid_launch");
    await this.opening.host.terminateProcesses({
      graceMs: Math.floor(input.timeoutMs / 2),
      killWaitMs: Math.floor(input.timeoutMs / 2),
    });
    // P05/composition must supply full-boundary evidence. Group exit cannot fabricate it.
    return { status: "unknown", session: this.session, reason: "unsupported" };
  }

  private beginStop(): void {
    this.stopped = true;
    this.stoppedSignal.abort();
    this.opening.host.fence();
    this.cancelPermissions();
    void this.runner?.stop().catch(() => undefined);
  }
  private cancelPermissions(): void {
    for (const request of this.permissions.values()) request.cancel();
    this.questions.cancel();
  }

  private interact<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      this.pendingInteractions >= 32 ||
      this.stopped ||
      this.finished ||
      signal.aborted
    )
      return Promise.reject(new HarnessHostError("request_unavailable"));
    this.pendingInteractions++;
    // Current canonical blocking state admits one user interaction at a time.
    const pending = this.interactionTail.then(() => {
      if (this.stopped || this.finished || signal.aborted)
        throw new HarnessHostError("request_unavailable");
      return operation();
    });
    this.interactionTail = pending.catch(() => undefined);
    return pending.finally(() => {
      this.pendingInteractions--;
    });
  }

  private async emit(payload: HarnessObservationPayload): Promise<void> {
    try {
      const background = this.foregroundTerminalStarted;
      if (payload.kind === "external_terminal")
        this.foregroundTerminalStarted = true;
      const observation =
        background &&
        payload.kind !== "external_terminal" &&
        payload.kind !== "quiescence"
          ? { ...payload, background: true as const }
          : payload;
      await this.opening.observe({
        session: this.session,
        externalTurnId: this.promptId,
        payload: observation,
      });
    } catch {
      this.deliveryFailed = true;
      throw new HarnessHostError("journal_corrupt");
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HarnessHostError("process_not_quiescent")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
