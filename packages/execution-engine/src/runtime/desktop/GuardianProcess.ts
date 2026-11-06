import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { constants as osConstants } from "node:os";
import type { LocalProcessOutput } from "./BoundedLocalProcess.js";
import { buildSingleProcessMacSandbox, SingleProcessMacCapabilityError } from "./SingleProcessMacSandbox.js";
import type { SingleExecutableProcessInput } from "./SingleExecutableProcess.js";

const OUTPUT_BYTES = 64 * 1024;
const DEADLINE_MS = 60_000;
const GRACE_MS = 250;

type Receipt = { pid: number; exitCode: number | null; signal: string | null; timedOut: boolean };

/** Private guardian protocol. Neither stdout nor stderr carries settlement truth. */
export class GuardianProcess {
  readonly result: Promise<LocalProcessOutput>;
  private readonly guardian: ChildProcess;
  private readonly control: Writable;
  private receipt: Receipt | undefined;
  private targetPid: number | undefined;
  private closed = false;
  private statusClosed = false;
  private cleanGuardianExit = false;
  private uncertain = false;
  private stopped = false;

  constructor(input: SingleExecutableProcessInput) {
    if (process.platform !== "darwin") throw new SingleProcessMacCapabilityError("Single-executable no-fork commands require Darwin Seatbelt");
    input.signal.throwIfAborted();
    try {
      if (typeof input.processHelperPath !== "string" || !isAbsolute(input.processHelperPath) || input.processHelperPath.includes("\0")
        || realpathSync(input.processHelperPath) !== input.processHelperPath || !statSync(input.processHelperPath).isFile()) {
        throw new SingleProcessMacCapabilityError("A trusted canonical process helper is required");
      }
    } catch (error) {
      if (error instanceof SingleProcessMacCapabilityError) throw error;
      throw new SingleProcessMacCapabilityError("The trusted process helper is unavailable", error);
    }
    if (!isAbsolute(input.executable) || input.executable.includes("\0") || Buffer.byteLength(input.executable) > 4_096
      || input.args.length > 255 || input.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 4_096)) {
      throw new SingleProcessMacCapabilityError("Invalid single-executable argv");
    }
    const sandbox = buildSingleProcessMacSandbox(input.executable, input.sandbox);
    const cwd = realpathSync(input.cwd);
    const cwdRelative = relative(input.sandbox.filesystemRoot, cwd);
    if (cwd !== input.cwd || cwdRelative === ".." || cwdRelative.startsWith(`..${sep}`) || isAbsolute(cwdRelative)) {
      throw new SingleProcessMacCapabilityError("Single-executable cwd must be canonical and inside the granted root");
    }
    const cwdFd = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      input.signal.throwIfAborted();
      this.guardian = spawn(input.processHelperPath, [
        "--timeout-ms", String(DEADLINE_MS), "--term-grace-ms", String(GRACE_MS), "--",
        "/usr/bin/sandbox-exec", ...sandbox.parameters, "-p", sandbox.profile, input.executable, ...input.args,
      ], {
        cwd: input.sandbox.filesystemRoot,
        detached: true,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: input.sandbox.filesystemRoot, TMPDIR: input.sandbox.filesystemRoot, LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", cwdFd],
      });
    } finally { closeSync(cwdFd); }
    // spawn can return a ChildProcess with missing pipes and report EMFILE or
    // ENFILE asynchronously. Install the failure observer before validation.
    this.guardian.on("error", () => { this.uncertain = true; });
    const stdoutStream = this.guardian.stdout;
    const stderrStream = this.guardian.stderr;
    const control = this.guardian.stdio[3];
    const status = this.guardian.stdio[4];
    if (!(stdoutStream instanceof Readable) || !(stderrStream instanceof Readable)
      || !(control instanceof Writable) || !(status instanceof Readable)) {
      for (const stream of this.guardian.stdio) {
        stream?.on("error", () => { this.uncertain = true; });
        // Drain available output/status without closing FD4 under the guardian.
        if (stream instanceof Readable && stream !== control) stream.resume();
      }
      if (control instanceof Writable) control.end("CANCEL\n");
      throw new SingleProcessMacCapabilityError("Process guardian channels could not be established");
    }
    this.control = control;
    this.result = new Promise((resolve, reject) => {
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let truncated = false;
      let statusBuffer = "";
      let statusBytes = 0;
      let settled = false;
      const rejectUncertain = (message: string, cause?: unknown) => {
        this.uncertain = true;
        this.stop();
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          input.signal.removeEventListener("abort", abort);
          reject(new SingleProcessMacCapabilityError(message, cause));
        }
      };
      const finish = () => {
        if (!this.closed || !this.statusClosed) return;
        clearTimeout(watchdog);
        input.signal.removeEventListener("abort", abort);
        if (settled) return;
        if (this.uncertain || !this.cleanGuardianExit || !this.receipt || statusBuffer !== "") {
          rejectUncertain("Process guardian exit was not verified by a complete terminal receipt");
          return;
        }
        settled = true;
        resolve({ exitCode: this.receipt.exitCode, signal: this.receipt.signal,
          stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated,
          timedOut: this.receipt.timedOut, outputClosed: false });
      };
      const append = (target: Buffer, chunk: Buffer) => {
        const remaining = OUTPUT_BYTES - target.length;
        if (chunk.length > remaining) truncated = true;
        return remaining > 0 ? Buffer.concat([target, chunk.subarray(0, remaining)]) : target;
      };
      stdoutStream.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      stderrStream.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      status.on("data", (chunk: Buffer) => {
        statusBytes += chunk.length;
        if (chunk.some((byte) => byte > 127 || byte === 0)) { rejectUncertain("Process guardian status was not ASCII"); return; }
        if (statusBytes > 1_024) { rejectUncertain("Process guardian status exceeded its bound"); return; }
        statusBuffer += chunk.toString("ascii");
        let newline: number;
        while ((newline = statusBuffer.indexOf("\n")) !== -1) {
          const line = statusBuffer.slice(0, newline);
          statusBuffer = statusBuffer.slice(newline + 1);
          try { this.acceptStatus(line); }
          catch (error) { rejectUncertain("Process guardian status was invalid", error); return; }
        }
      });
      status.once("end", () => { this.statusClosed = true; finish(); });
      for (const stream of [stdoutStream, stderrStream, status, control]) {
        stream.on("error", (error) => rejectUncertain("Process guardian channel failed", error));
      }
      this.guardian.once("error", (error) => rejectUncertain("Process guardian could not be launched", error));
      this.guardian.once("exit", (code, signal) => { this.cleanGuardianExit = code === 0 && signal === null; });
      this.guardian.once("close", () => { this.closed = true; finish(); });
      const abort = () => this.stop();
      input.signal.addEventListener("abort", abort, { once: true });
      // The C guardian owns the real deadline even after this host disappears.
      // This watchdog only bounds Node's wait; it never manufactures exit proof.
      const watchdog = setTimeout(() => {
        rejectUncertain("Process guardian terminal receipt did not arrive before the bound");
        stdoutStream.destroy(); stderrStream.destroy(); status.destroy();
      }, DEADLINE_MS + GRACE_MS + 2_000);
      watchdog.unref();
      if (input.signal.aborted) this.stop();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Closing this pipe is also the owner-loss signal when the utility host dies.
    // Never kill the guardian: it must keep ownership until waitpid completes.
    this.control.end("CANCEL\n");
  }

  get quiescent(): boolean {
    return this.closed && this.statusClosed && this.cleanGuardianExit && !!this.receipt && !this.uncertain;
  }

  private acceptStatus(line: string): void {
    const start = /^START ([1-9][0-9]*)$/.exec(line);
    if (start) {
      const pid = Number(start[1]);
      if (this.targetPid !== undefined || this.receipt || !Number.isSafeInteger(pid)) throw new Error("Duplicate or invalid guardian START");
      this.targetPid = pid;
      return;
    }
    const done = /^DONE ([1-9][0-9]*) (-1|[0-9]+) ([0-9]+) (exit|cancel|timeout|parent_lost)$/.exec(line);
    if (!done || this.receipt) throw new Error("Invalid guardian DONE");
    const pid = Number(done[1]), exitCode = Number(done[2]), signalNumber = Number(done[3]);
    if (pid !== this.targetPid || !Number.isSafeInteger(pid) || !Number.isSafeInteger(exitCode) || !Number.isSafeInteger(signalNumber)
      || !((exitCode >= 0 && exitCode <= 255 && signalNumber === 0) || (exitCode === -1 && signalNumber > 0))) {
      throw new Error("Guardian DONE identity or wait status mismatch");
    }
    const signal = signalNumber === 0 ? null : Object.entries(osConstants.signals).find(([, value]) => value === signalNumber)?.[0];
    if (signal === undefined) throw new Error("Unknown guardian terminal signal");
    this.receipt = { pid, exitCode: exitCode === -1 ? null : exitCode, signal, timedOut: done[4] === "timeout" };
  }
}
