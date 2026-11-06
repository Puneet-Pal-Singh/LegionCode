import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const KILL_DELAY_MS = 250;

export type LocalProcessOutput = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  outputClosed: boolean;
};

/** POSIX process-group lifetime. A kill request is never evidence of exit. */
export class BoundedLocalProcess {
  readonly result: Promise<LocalProcessOutput>;
  private readonly child: ChildProcessWithoutNullStreams;
  private closed = false;
  private spawned = false;
  private terminationRequested = false;
  private forcedOutputClose = false;
  private rejectResult: ((error: Error) => void) | undefined;
  private outputTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(input: { command: string; cwd: string; signal: AbortSignal }) {
    if (process.platform === "win32") throw new Error("Local bash requires a POSIX runtime");
    input.signal.throwIfAborted();
    this.child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", input.command], {
      cwd: input.cwd,
      detached: true,
      // Never inherit provider credentials or shell startup hooks.
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: input.cwd, LANG: "C.UTF-8" },
      stdio: "pipe",
    });
    this.child.stdin.end();
    this.result = new Promise((resolve, reject) => {
      this.rejectResult = reject;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let failure: Error | undefined;
      const append = (target: Buffer, chunk: Buffer) => {
        const remaining = OUTPUT_BYTES - target.length;
        if (chunk.length > remaining) truncated = true;
        return remaining > 0 ? Buffer.concat([target, chunk.subarray(0, remaining)]) : target;
      };
      this.child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      this.child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const abort = () => this.stop();
      input.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; this.stop(); }, COMMAND_TIMEOUT_MS);
      this.child.once("spawn", () => {
        this.spawned = true;
        if (input.signal.aborted || this.terminationRequested) this.signalGroup("SIGTERM");
      });
      this.child.once("error", (error) => { failure = error; });
      // Even a successful shell can leave background children holding stdio open.
      this.child.once("exit", () => this.stop());
      this.child.once("close", (exitCode, signal) => {
        this.closed = true;
        clearTimeout(timeout);
        clearTimeout(this.outputTimer);
        input.signal.removeEventListener("abort", abort);
        if (this.killTimer && !this.groupExists()) clearTimeout(this.killTimer);
        if (failure) reject(failure);
        else resolve({ exitCode, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated, timedOut, outputClosed: this.forcedOutputClose });
      });
      if (input.signal.aborted) this.stop();
    });
  }

  stop(): void {
    if (this.terminationRequested) return;
    this.terminationRequested = true;
    this.signalGroup("SIGTERM");
    this.killTimer = setTimeout(() => this.signalGroup("SIGKILL"), KILL_DELAY_MS);
    // A detached descendant can retain inherited pipes after the shell exits.
    // Bound collection without treating forced pipe closure as quiescence proof.
    this.outputTimer = setTimeout(() => {
      this.forcedOutputClose = true;
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.rejectResult?.(new Error("Command exit or output closure could not be confirmed"));
    }, KILL_DELAY_MS + 1_000);
  }

  get quiescent(): boolean {
    return this.closed && !this.forcedOutputClose && !this.groupExists();
  }

  private groupExists(): boolean {
    if (!this.child.pid || !this.spawned) return false;
    try { process.kill(-this.child.pid, 0); return true; }
    catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        // Retain the group as nonquiescent; callers must not settle a clean snapshot.
        try { this.child.kill(signal); }
        catch { /* No exit is inferred; quiescence remains independently checked. */ }
      }
    }
  }
}
