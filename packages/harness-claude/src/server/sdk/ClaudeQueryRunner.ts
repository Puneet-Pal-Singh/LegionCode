import { ClaudeOwnedWork } from "./ClaudeOwnedWork.js";
import { claudeSandbox } from "./ClaudeSandbox.js";
import { frozenClaudeLaunchEnvironment } from "../ClaudeAuthentication.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  HookCallback,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "../../settings.js";
import { fencedClaudePermission } from "../ClaudePermissionMapper.js";

/** One outstanding input only; never replay a possibly accepted send. */
class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage | undefined;
  private wake: (() => void) | undefined;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed || this.pending)
      throw new Error("Claude input is unavailable");
    this.pending = message;
    this.wake?.();
  }

  discardPending(): void {
    this.pending = undefined;
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.pending) {
        const message = this.pending;
        this.pending = undefined;
        yield message;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    }
  }
}

type RunnerOptions = Required<
  Pick<
    Options,
    "cwd" | "model" | "env" | "canUseTool" | "spawnClaudeCodeProcess"
  >
> &
  Pick<Options, "resume" | "sessionId"> & {
    readonly beforeTool: HookCallback;
    readonly instanceDirectory: string;
    readonly journalDirectory: string;
  };

/** Private SDK plumbing. Host owns binding, process tree and durable observation delivery. */
export class ClaudeQueryRunner {
  private readonly input = new ClaudeInput();
  private readonly permissions = new AbortController();
  private readonly abort = new AbortController();
  private readonly sdk: Query;
  private readonly selectedModel: string;
  private observing = false;
  private drained = false;
  private closedBeforeDrain = false;
  private initialized = false;
  private closed = false;
  private busy = false;
  private readonly work = new ClaudeOwnedWork();
  private stopping = false;
  private readonly stopRequests = new Map<string, string | undefined>();
  private readonly submitted = new Set<string>();
  private stopPromise: Promise<void> | undefined;
  private readonly workWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();

  constructor(options: RunnerOptions) {
    const { beforeTool, instanceDirectory, journalDirectory, ...sdkOptions } =
      options;
    const launchEnvironment = frozenClaudeLaunchEnvironment(options.env);
    this.selectedModel = options.model;
    this.sdk = query({
      prompt: this.input,
      options: {
        ...sdkOptions,
        ...claudeSandbox({
          workspaceRoot: options.cwd,
          homeDirectory: launchEnvironment.HOME!,
          instanceDirectory,
          journalDirectory,
        }),
        additionalDirectories: [],
        env: { ...launchEnvironment },
        // SDK env handling is version-sensitive. Do not forward its spawn env to the host.
        spawnClaudeCodeProcess: (spawnOptions) =>
          options.spawnClaudeCodeProcess({
            ...spawnOptions,
            env: launchEnvironment,
          }),
        abortController: this.abort,
        canUseTool: fencedClaudePermission(
          options.canUseTool,
          this.permissions.signal,
        ),
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input, toolUseId, context) => {
                  if (
                    this.permissions.signal.aborted ||
                    context.signal.aborted
                  ) {
                    return {
                      continue: false,
                      decision: "block",
                      reason: "Claude session stopped",
                    };
                  }
                  const result = await beforeTool(input, toolUseId, context);
                  if (
                    this.permissions.signal.aborted ||
                    context.signal.aborted
                  ) {
                    return {
                      continue: false,
                      decision: "block",
                      reason: "Claude session stopped",
                    };
                  }
                  return result;
                },
              ],
              onFailure: "block",
              timeout: 300,
            },
          ],
        },
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        plugins: [],
        perTaskStopAffordance: false,
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
        includePartialMessages: true,
        persistSession: true,
        // No background-preservation opt-in: Stop terminates the whole owned session.
      },
    });
  }

  /** Handshake must succeed before accepting any user input. */
  async initialize(): Promise<void> {
    if (this.closed) throw new Error("Claude session is closed");
    try {
      const result = await this.withDeadline(
        this.sdk.initializationResult(),
        15_000,
      );
      if (
        result.claude_code_version !== CLAUDE_CODE_VERSION ||
        result.account.apiKeySource !== "ANTHROPIC_API_KEY" ||
        result.account.apiProvider !== "firstParty" ||
        result.hooks_applied !== true ||
        result.hook_on_failure_supported !== true ||
        !result.models.some(
          (model) =>
            model.resolvedModel === this.selectedModel ||
            (model.value === this.selectedModel &&
              model.resolvedModel === undefined),
        )
      ) {
        throw new Error(
          "Claude runtime version or selected payer does not match",
        );
      }
      if (this.closed)
        throw new Error("Claude session closed during initialization");
      this.initialized = true;
    } catch {
      this.close();
      throw new Error("Claude initialization failed; no input was accepted");
    }
  }

  /** Sink resolves only after host journal / canonical commit; no parallel event delivery. */
  async observe(sink: (message: SDKMessage) => Promise<void>): Promise<void> {
    if (this.observing) throw new Error("Claude query already has an observer");
    this.observing = true;
    try {
      for await (const message of this.sdk) {
        if (message.type === "system" && message.subtype === "init") {
          // A different payer must never be accepted just because a prompt can run.
          if (
            message.apiKeySource !== "ANTHROPIC_API_KEY" ||
            message.claude_code_version !== CLAUDE_CODE_VERSION ||
            message.model !== this.selectedModel
          ) {
            throw new Error(
              "Claude did not select the explicitly supplied API key",
            );
          }
        }
        await sink(message);
        this.work.observe(message);
        if (this.stopping) this.stopOwnedTasks();
        if (message.type === "result") this.busy = false;
        if (this.work.settled) {
          for (const waiter of this.workWaiters) waiter.resolve();
        }
      }
      this.drained = true;
    } finally {
      this.close();
    }
  }

  get observationsDrained(): boolean {
    return this.drained && !this.closedBeforeDrain;
  }

  submit(message: SDKUserMessage): void {
    if (this.closed || this.stopping || !this.initialized || this.busy)
      throw new Error("Claude session is not ready for a new turn");
    if (
      !message.uuid ||
      this.submitted.has(message.uuid) ||
      this.submitted.size >= 4096
    ) {
      throw new Error(
        "Claude requires a fresh explicit input identity within the session limit",
      );
    }
    this.submitted.add(message.uuid);
    this.busy = true;
    this.work.submitted();
    this.input.push(message);
  }

  /** Native task settlement only. This never replaces the host's OS quiescence proof. */
  async awaitOwnedWork(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Claude work wait cancelled");
    if (this.closed) throw new Error("Claude task stream is closed");
    if (this.work.settled) return;
    let waiter:
      | {
          readonly resolve: () => void;
          readonly reject: (error: Error) => void;
        }
      | undefined;
    const abort = () => waiter?.reject(new Error("Claude work wait cancelled"));
    try {
      await new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject };
        this.workWaiters.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    } finally {
      signal.removeEventListener("abort", abort);
      if (waiter) this.workWaiters.delete(waiter);
    }
  }

  /** Acceptance/cleanup only. The host must separately prove descendant quiescence. */
  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.permissions.abort();
    this.input.discardPending();
    this.stopping = true;
    try {
      await this.withDeadline(
        (async () => {
          // The published typed API takes no options. Queued UUID receipts are not quiescence.
          await this.sdk.interrupt();
          this.stopOwnedTasks();
          // Receipts do not settle tasks. Keep observing until committed native idle
          // and both task streams are empty, including tasks first seen during Stop.
          await this.awaitOwnedWork(this.abort.signal);
        })(),
        5_000,
      );
      // EOF permits final task notifications to drain through observe().
      this.input.close();
    } catch {
      this.close();
      throw new Error("Claude Stop controls failed or timed out");
    }
  }

  private stopOwnedTasks(): void {
    for (const [task, run] of this.work.running()) {
      const previous = this.stopRequests.get(task);
      if (
        this.stopRequests.has(task) &&
        (run === undefined || (previous !== undefined && run <= previous))
      )
        continue;
      if (this.stopRequests.size >= 4096 && !this.stopRequests.has(task))
        throw new Error("Claude Stop task limit exceeded");
      this.stopRequests.set(task, run);
      // Do not retry an ambiguous control response. Failure closes observation;
      // the canonical host still owns forced cleanup and failure settlement.
      void this.sdk.stopTask(task).catch(() => this.close());
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
            () => reject(new Error("Claude control deadline exceeded")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    // Query.close() discards remaining messages. A later iterator EOF cannot
    // retroactively prove that those observations reached the canonical sink.
    if (!this.drained) this.closedBeforeDrain = true;
    this.closed = true;
    for (const waiter of this.workWaiters)
      waiter.reject(new Error("Claude task stream closed before settlement"));
    this.permissions.abort();
    this.input.close();
    this.sdk.close();
    this.abort.abort();
  }
}
