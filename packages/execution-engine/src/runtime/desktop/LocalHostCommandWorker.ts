import { ToolCallItemContentSchema, RunSchema, TurnSchema, RunAttemptIdSchema } from "@repo/platform-protocol";
import type { RuntimeKernelDependencies, StartTurnInput, WorkerProtocolPort, WorkerToolResult } from "@repo/runtime-kernel";
import { BASH_TOOL_INPUT_SCHEMA } from "../tools/CodingToolRegistry.js";
import { assertLocalToolApproved } from "./LocalToolApproval.js";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";
import { MacHostBrokerClient, type MacHostCommandAttempt, type MacHostCommandResource } from "./MacHostBrokerClient.js";
import { MacHostBrokerError } from "./MacHostBrokerProtocol.js";
import type { FileHandle } from "node:fs/promises";

type Input = Parameters<WorkerProtocolPort["executeTool"]>[0];
/** Existing physical writer's borrowed authority. Implemented by its owner, not
 * this worker. Registering a broker resource is not a second lease registry. */
export interface LocalHostCommandAuthority {
  readonly attempt: LocalTurnAttemptIdentity;
  readonly rootDirectory: FileHandle;
  readonly writerLease: FileHandle;
  readonly namespaceDirectory: FileHandle;
  readonly filesystemRoot: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  trackHostResource(resource: MacHostCommandResource): void;
  markUnknown(): void;
}
export interface LocalHostCommandLease {
  withMutationAuthority<T>(workspaceId: LocalTurnAttemptIdentity["workspaceId"],
    operation: (authority: LocalHostCommandAuthority) => Promise<T>): Promise<T>;
}

/** Real C1 consumer for the canonical bash definition. Runtime owns permission,
 * lifecycle, output publication, capture and final settlement. */
export class LocalHostCommandWorker implements WorkerProtocolPort {
  private readonly admission: Pick<StartTurnInput, "run" | "turn" | "runAttemptId">;
  private readonly identity: LocalTurnAttemptIdentity;
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<WorkerToolResult>>();
  private tail: Promise<unknown> = Promise.resolve();
  private resource: MacHostCommandAttempt | null = null;
  private authority: LocalHostCommandAuthority | null = null;
  private unknown = false;
  constructor(private readonly options: {
    admission: Pick<StartTurnInput, "run" | "turn" | "runAttemptId">;
    lease: LocalHostCommandLease;
    broker: MacHostBrokerClient;
    lifecycleEvents: Pick<RuntimeKernelDependencies["lifecycleEvents"], "replay">;
    assertMutationReady: (identity: LocalTurnAttemptIdentity) => Promise<void>;
  }) {
    this.admission = { run: RunSchema.parse(options.admission.run), turn: TurnSchema.parse(options.admission.turn),
      runAttemptId: RunAttemptIdSchema.parse(options.admission.runAttemptId) };
    const { run, turn, runAttemptId } = this.admission;
    if (turn.runId !== run.id || turn.threadId !== run.threadId) throw new MacHostBrokerError("invalid_admission", false);
    this.identity = Object.freeze({ workspaceId: run.workspaceId, threadId: run.threadId,
      runId: run.id, turnId: turn.id, runAttemptId });
  }
  executeTool(input: Input): Promise<WorkerToolResult> {
    let captured: Input;
    try { captured = { ...input, workspace: { ...input.workspace }, toolCall: ToolCallItemContentSchema.parse(input.toolCall),
      approval: input.approval ? { ...input.approval } : null }; }
    catch { return Promise.resolve(this.failure("invalid_tool_input", false)); }
    const operation = this.tail.then(() => this.execute(captured)).catch((error: unknown) => {
      if (error instanceof MacHostBrokerError && error.outcomeUnknown) this.markUnknown();
      if (!this.unknown && (this.stopped.signal.aborted || captured.signal?.aborted))
        return { kind: "cancelled" as const, reason: "Local host command interrupted" };
      return this.failure(error instanceof MacHostBrokerError ? error.reason : "host_command_failed", this.unknown);
    });
    this.tail = operation;
    this.pending.add(operation); void operation.then(() => this.pending.delete(operation)); return operation;
  }
  stop(turnId: LocalTurnAttemptIdentity["turnId"], reason = "Local host command interrupted"): void {
    if (turnId !== this.identity.turnId) return;
    if (!this.stopped.signal.aborted) this.stopped.abort(reason);
    if (this.resource) void this.resource.seal().catch(() => this.markUnknown());
  }
  async awaitQuiescence(input: { turnId: LocalTurnAttemptIdentity["turnId"]; timeoutMs: number }): Promise<boolean> {
    if (input.turnId !== this.identity.turnId || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 0 || this.unknown) return false;
    /* This is the kernel's final resource barrier, not a per-command status
     * read. Once called, no later command in this worker can be admitted. */
    this.stop(input.turnId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const proof = (async () => {
      await Promise.all([...this.pending]);
      if (this.resource) await this.resource.seal();
      return !this.unknown && this.pending.size === 0 && (!this.resource || this.resource.quiescent);
    })().catch(() => { this.markUnknown(); return false; });
    try {
      return await Promise.race([proof, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), input.timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private async execute(input: Input): Promise<WorkerToolResult> {
    if (this.unknown || this.stopped.signal.aborted) return this.failure("attempt_unavailable", true);
    if (input.toolCall.toolName !== "bash") return this.failure("tool_outside_host_backend", false);
    const parsed = BASH_TOOL_INPUT_SCHEMA.parse(input.toolCall.input);
    await assertLocalToolApproved({ admission: this.admission, lifecycleEvents: this.options.lifecycleEvents,
      input, schema: BASH_TOOL_INPUT_SCHEMA });
    return this.options.lease.withMutationAuthority(this.identity.workspaceId, async (authority) => {
      if (Object.keys(this.identity).some((key) => authority.attempt[key as keyof LocalTurnAttemptIdentity] !== this.identity[key as keyof LocalTurnAttemptIdentity]) ||
          authority.filesystemRoot !== input.workspace.filesystemRoot) throw new MacHostBrokerError("writer_attempt_changed", false);
      const signal = AbortSignal.any([this.stopped.signal, authority.signal, ...(input.signal ? [input.signal] : [])]);
      const abort = () => this.stop(this.identity.turnId);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        signal.throwIfAborted(); await authority.assertCurrent(); await this.options.assertMutationReady(this.identity);
        signal.throwIfAborted(); await authority.assertCurrent();
        if (!this.resource) {
          this.authority = authority;
          try {
            this.resource = this.options.broker.createAttempt({ attempt: this.identity,
              rootDirectory: authority.rootDirectory, writerLease: authority.writerLease, namespaceDirectory: authority.namespaceDirectory });
            /* Preparation/start are separate. Register before the first request
             * can reserve a UID, provision access or create a target process. */
            authority.trackHostResource(this.resource);
          } catch (error) { this.markUnknown(); if (this.resource) void this.resource.seal().catch(() => undefined); throw error; }
        } else if (this.authority !== authority) throw new MacHostBrokerError("writer_authority_changed", true);
        const result = await this.resource.execute(input.toolCall.toolCallId, parsed.command, parsed.cwd ?? ".");
        if (signal.aborted) return { kind: "cancelled", reason: "Local command stopped after verified UID and output closure" };
        const raw = Buffer.from(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""));
        const maximum = 20000;
        const output = { content: new TextDecoder().decode(raw.subarray(0, maximum), { stream: true }), metadata: {
          exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
          truncated: result.truncated || raw.length > maximum,
        } };
        if (result.exitCode !== 0 || result.signal !== null || result.timedOut) return { kind: "failed",
          disposition: result.timedOut ? "terminal" : "recoverable", failure: {
            code: result.timedOut ? "command_timed_out" : "command_failed", message: "The local project command did not succeed",
            retryable: false, correlationId: null, details: output,
          } };
        return { kind: "completed", output };
      } finally { signal.removeEventListener("abort", abort); }
    });
  }
  private markUnknown(): void { this.unknown = true; this.authority?.markUnknown(); }
  private failure(reason: string, uncertain: boolean): WorkerToolResult {
    return { kind: "failed", disposition: uncertain ? "terminal" : "recoverable", failure: {
      code: uncertain ? "internal_error" : "policy_denied", message: "Local host execution: " + reason,
      retryable: false, correlationId: null, details: null,
    } };
  }
}
