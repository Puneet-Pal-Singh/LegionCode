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
  Pick<Options, "resume"> & { readonly beforeTool: HookCallback };

/** Private SDK plumbing. Host owns binding, process tree and durable observation delivery. */
export class ClaudeQueryRunner {
  private readonly input = new ClaudeInput();
  private readonly permissions = new AbortController();
  private readonly abort = new AbortController();
  private readonly sdk: Query;
  private observing = false;
  private initialized = false;
  private closed = false;
  private busy = false;
  private readonly submitted = new Set<string>();
  private readonly tasks = new Set<string>();
  private stopPromise: Promise<void> | undefined;

  constructor(options: RunnerOptions) {
    const { beforeTool, ...sdkOptions } = options;
    this.sdk = query({
      prompt: this.input,
      options: {
        ...sdkOptions,
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
              timeout: 30,
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
        result.hooks_applied !== true ||
        result.hook_on_failure_supported !== true
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
            message.claude_code_version !== CLAUDE_CODE_VERSION
          ) {
            throw new Error(
              "Claude did not select the explicitly supplied API key",
            );
          }
        }
        if (
          message.type === "system" &&
          message.subtype === "background_tasks_changed"
        ) {
          if (message.tasks.length > 4096)
            throw new Error("Claude task tracking limit exceeded");
          this.tasks.clear();
          for (const task of message.tasks) this.tasks.add(task.task_id);
        }
        await sink(message);
        if (message.type === "result") this.busy = false;
        if (message.type === "system" && message.subtype === "task_started") {
          if (this.tasks.size >= 4096)
            throw new Error("Claude task tracking limit exceeded");
          this.tasks.add(message.task_id);
        }
        if (
          message.type === "system" &&
          message.subtype === "task_notification"
        )
          this.tasks.delete(message.task_id);
      }
    } finally {
      this.close();
    }
  }

  submit(message: SDKUserMessage): void {
    if (this.closed || !this.initialized || this.busy)
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
    this.input.push(message);
  }

  /** Acceptance/cleanup only. The host must separately prove descendant quiescence. */
  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.permissions.abort();
    this.input.close();
    this.closed = true;
    try {
      await this.withDeadline(
        (async () => {
          // The published typed API takes no options. Queued UUID receipts are not quiescence.
          await this.sdk.interrupt();
          await Promise.all(
            [...this.tasks].map((task) => this.sdk.stopTask(task)),
          );
        })(),
        5_000,
      );
    } finally {
      this.close();
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
    this.closed = true;
    this.permissions.abort();
    this.input.close();
    this.sdk.close();
    this.abort.abort();
  }
}
