import { buildSingleProcessMacSandbox, type SingleProcessMacSandbox } from "./SingleProcessMacSandbox.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

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

export type BoundedLocalProcessInput = { cwd: string; signal: AbortSignal } & (
  | { command: string }
  | { executable: string; args: readonly string[]; sandbox: SingleProcessMacSandbox }
);

/** Group lifetime for legacy bash; single-PID lifetime only under Darwin no-fork. */
export class BoundedLocalProcess {
  readonly result: Promise<LocalProcessOutput>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly singleExecutable: boolean;
  private closed = false;
  private spawned = false;
  private terminationRequested = false;
  private forcedOutputClose = false;
  private rejectResult: ((error: Error) => void) | undefined;
  private outputTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(input: BoundedLocalProcessInput) {
    if (process.platform === "win32") throw new Error("Local bash requires a POSIX runtime");
    input.signal.throwIfAborted();
    this.singleExecutable = "executable" in input;
    let executable: string;
    let args: readonly string[];
    if ("executable" in input) {
      if (process.platform !== "darwin") throw new Error("Single-executable no-fork commands require Darwin Seatbelt");
      if (!isAbsolute(input.executable) || input.executable.includes("\0") || Buffer.byteLength(input.executable) > 4_096
        || !isAbsolute(input.cwd) || input.cwd.includes("\0")
        || input.args.length > 255 || input.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 4_096)) {
        throw new Error("Invalid single-executable argv");
      }
      const sandbox = buildSingleProcessMacSandbox(input.executable, input.sandbox);
      const cwd = realpathSync(input.cwd);
      const cwdRelative = relative(input.sandbox.filesystemRoot, cwd);
      if (cwd !== input.cwd || cwdRelative === ".." || cwdRelative.startsWith(`..${sep}`) || isAbsolute(cwdRelative)) {
        throw new Error("Single-executable cwd must be canonical and inside the granted root");
      }
      executable = "/usr/bin/sandbox-exec";
      args = [...sandbox.parameters, "-p", sandbox.profile, input.executable, ...input.args];
    } else {
      executable = "/bin/bash";
      args = ["--noprofile", "--norc", "-c", input.command];
    }
    this.child = spawn(executable, args, {
      cwd: input.cwd,
      detached: true,
      // Never inherit provider credentials or shell startup hooks.
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "sandbox" in input ? input.sandbox.filesystemRoot : input.cwd,
        TMPDIR: "sandbox" in input ? input.sandbox.filesystemRoot : input.cwd, LANG: "C.UTF-8" },
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
        if (input.signal.aborted || this.terminationRequested) this.signalProcess("SIGTERM");
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
    this.signalProcess("SIGTERM");
    this.killTimer = setTimeout(() => this.signalProcess("SIGKILL"), KILL_DELAY_MS);
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
    return this.closed && !this.forcedOutputClose && (this.singleExecutable || !this.groupExists());
  }

  private groupExists(): boolean {
    if (!this.child.pid || !this.spawned) return false;
    try { process.kill(-this.child.pid, 0); return true; }
    catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
  }

  private signalProcess(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    if (this.singleExecutable) {
      // Seatbelt denies fork/posix_spawn before untrusted exec. Exec retains
      // this PID, so ChildProcess exit is complete process-lifetime evidence.
      try { this.child.kill(signal); }
      catch { /* No exit is inferred; close remains required. */ }
      return;
    }
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
