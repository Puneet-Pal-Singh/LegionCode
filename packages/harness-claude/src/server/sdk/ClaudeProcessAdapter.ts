import { frozenClaudeLaunchEnvironment } from "../ClaudeAuthentication.js";
import { EventEmitter } from "node:events";
import { PassThrough, Transform } from "node:stream";
import type {
  ProcessExit,
  ProcessGroupSettlement,
  SupervisedProcess,
} from "@repo/harness-core/server";
import type {
  SpawnedProcess,
  SpawnOptions,
  Options,
} from "@anthropic-ai/claude-agent-sdk";

/** SDK requires a synchronous handle; the canonical host authorizes/launches asynchronously. */
class DeferredClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough({ highWaterMark: 65_536 });
  private outputBytes = 0;
  readonly stdout = new Transform({
    highWaterMark: 65_536,
    transform: (chunk: Buffer, _encoding, callback) => {
      this.outputBytes += chunk.byteLength;
      // Bound SDK-internal queues even while the canonical commit sink is slow.
      if (this.outputBytes > 64 * 1024 * 1024) {
        this.kill("SIGTERM");
        callback(new Error("Claude session output budget exceeded"));
      } else callback(null, chunk);
    },
  });
  private process: SupervisedProcess | undefined;
  private exit: Extract<ProcessExit, { kind: "exited" }> | undefined;
  private termination: Promise<ProcessGroupSettlement> | undefined;
  private pendingKill: NodeJS.Signals | undefined;
  private reportedExit = false;

  constructor(launch: () => Promise<SupervisedProcess>) {
    super();
    this.stdout.on("error", () =>
      this.fail("Claude session output budget or stream failed"),
    );
    // The SDK attaches its error listener after this handle is returned.
    void Promise.resolve()
      .then(launch)
      .then((process) => {
        this.process = process;
        process.stdin.on("error", () =>
          this.fail("Claude process input closed"),
        );
        process.stdout.on("error", () =>
          this.fail("Claude process output closed"),
        );
        void process.exited
          .then((exit) => {
            if (exit.kind === "spawn_failed") {
              this.fail("Claude host process failed");
              return;
            }
            this.exit = exit;
            this.reportExit(exit.code, exit.signal);
          })
          .catch(() => this.fail("Claude host process failed"));
        this.stdin.pipe(process.stdin);
        process.stdout.pipe(this.stdout);
        if (this.pendingKill && !this.kill(this.pendingKill))
          this.fail("Claude process termination request failed");
      })
      .catch(() => {
        this.fail("Claude host process launch failed");
      });
  }

  get killed(): boolean {
    // SDK acknowledgement of a termination request, never settlement evidence.
    return this.pendingKill !== undefined;
  }
  get exitCode(): number | null {
    return this.exit?.code ?? null;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.exit?.signal ?? null;
  }

  kill(signal: NodeJS.Signals): boolean {
    // The pinned SDK requests only TERM and KILL. The existing supervisor owns
    // the bounded TERM/KILL policy and coalesces an in-flight termination.
    if (signal !== "SIGTERM" && signal !== "SIGKILL") return false;
    if (this.process && !this.termination) {
      try {
        this.termination = this.process.terminate({
          graceMs: signal === "SIGKILL" ? 0 : 5000,
          killWaitMs: 1000,
        });
      } catch {
        return false;
      }
      void this.termination.catch(() =>
        this.fail("Claude process termination request failed"),
      );
    }
    this.pendingKill = signal;
    return true;
  }

  private fail(category: string): void {
    this.kill("SIGTERM");
    this.stdin.end();
    this.stdout.end();
    // An async launch may fail after SDK shutdown removed its listeners. End the
    // handle and terminate the process without crashing the supervisor with an
    // unhandled EventEmitter error. Host retains the launch/cleanup outcome.
    if (this.listenerCount("error") > 0)
      this.emit("error", new Error(category));
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
  launch: (options: SpawnOptions) => Promise<SupervisedProcess>,
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  const environment = frozenClaudeLaunchEnvironment(selectedEnvironment);
  return (options) =>
    new DeferredClaudeProcess(() => launch({ ...options, env: environment }));
}
