import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  SpawnedProcess,
  SpawnOptions,
  Options,
} from "@anthropic-ai/claude-agent-sdk";

/** SDK requires a synchronous handle; the canonical host authorizes/launches asynchronously. */
class DeferredClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough({ highWaterMark: 65_536 });
  readonly stdout = new PassThrough({ highWaterMark: 65_536 });
  private child: SpawnedProcess | undefined;
  private pendingKill: NodeJS.Signals | undefined;
  private reportedExit = false;

  constructor(launch: () => Promise<SpawnedProcess>) {
    super();
    // The SDK attaches its error listener after this handle is returned.
    void Promise.resolve()
      .then(launch)
      .then(
        (child) => {
          this.child = child;
          child.on("error", () =>
            this.emit("error", new Error("Claude host process failed")),
          );
          child.on("exit", (code, signal) => this.reportExit(code, signal));
          child.stdin.on("error", () =>
            this.emit("error", new Error("Claude process input closed")),
          );
          child.stdout.on("error", () =>
            this.emit("error", new Error("Claude process output closed")),
          );
          this.stdin.pipe(child.stdin);
          child.stdout.pipe(this.stdout);
          if (this.pendingKill) child.kill(this.pendingKill);
          if (child.exitCode !== null || child.signalCode)
            this.reportExit(child.exitCode, child.signalCode ?? null);
        },
        () => {
          this.stdin.end();
          this.stdout.end();
          this.emit("error", new Error("Claude host process launch failed"));
        },
      );
  }

  get killed(): boolean {
    return this.pendingKill !== undefined || (this.child?.killed ?? false);
  }
  get exitCode(): number | null {
    return this.child?.exitCode ?? null;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.child?.signalCode ?? null;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.pendingKill = signal;
    return this.child?.kill(signal) ?? true;
  }

  private reportExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.reportedExit) return;
    this.reportedExit = true;
    // stdout may still drain after process exit; its pipe owns end-of-stream.
    this.emit("exit", code, signal);
  }
}

/** This translates only SDK plumbing; launch must use the host's enforced execution policy. */
export function claudeProcessAdapter(
  launch: (options: SpawnOptions) => Promise<SpawnedProcess>,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (options) => new DeferredClaudeProcess(() => launch(options));
}
