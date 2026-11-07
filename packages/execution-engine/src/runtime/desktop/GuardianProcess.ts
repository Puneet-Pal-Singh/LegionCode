import { spawn, type ChildProcess } from "node:child_process";
import { fstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { constants as osConstants } from "node:os";
import type { LocalProcessOutput } from "./NativeProcessOutput.js";
import {
  buildSingleProcessMacSandbox,
  SingleProcessMacCapabilityError,
} from "./SingleProcessMacSandbox.js";
import type { SingleExecutableProcessInput } from "./SingleExecutableProcess.js";

const OUTPUT_BYTES = 64 * 1024;
const DEADLINE_MS = 60_000;
const GRACE_MS = 250;

/** No terminal process truth is available; consumers must not infer clean settlement. */
export class SingleProcessMacLifetimeUncertainError extends Error {
  readonly code = "single_executable_lifetime_uncertain" as const;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SingleProcessMacLifetimeUncertainError";
  }
}

type Receipt = {
  pid: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
};

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
    if (process.platform !== "darwin")
      throw new SingleProcessMacCapabilityError(
        "Single-executable no-fork commands require Darwin Seatbelt",
      );
    input.signal.throwIfAborted();
    try {
      if (
        typeof input.processHelperPath !== "string" ||
        !isAbsolute(input.processHelperPath) ||
        input.processHelperPath.includes("\0") ||
        realpathSync(input.processHelperPath) !== input.processHelperPath ||
        !statSync(input.processHelperPath).isFile()
      ) {
        throw new SingleProcessMacCapabilityError(
          "A trusted canonical process helper is required",
        );
      }
    } catch (error) {
      if (error instanceof SingleProcessMacCapabilityError) throw error;
      throw new SingleProcessMacCapabilityError(
        "The trusted process helper is unavailable",
        error,
      );
    }
    if (
      !isAbsolute(input.executable) ||
      input.executable.includes("\0") ||
      Buffer.byteLength(input.executable) > 4_096 ||
      input.args.length > 255 ||
      input.args.some(
        (arg) =>
          typeof arg !== "string" ||
          arg.includes("\0") ||
          Buffer.byteLength(arg) > 4_096,
      )
    ) {
      throw new SingleProcessMacCapabilityError(
        "Invalid single-executable argv",
      );
    }
    const sandbox = buildSingleProcessMacSandbox(
      input.executable,
      input.sandbox,
    );
    // The descriptor is the authority. Absolute cwd is made relative only
    // lexically; the C helper walks every component from FD5 without following
    // symlinks or reopening the root pathname.
    if (
      typeof input.cwd !== "string" ||
      input.cwd.length === 0 ||
      input.cwd.includes("\0") ||
      input.cwd.includes("\\") ||
      (isAbsolute(input.cwd) && resolve(input.cwd) !== input.cwd)
    ) {
      throw new SingleProcessMacCapabilityError(
        "Unsupported held-root cwd spelling",
      );
    }
    const cwdRelative =
      input.cwd === "."
        ? ""
        : isAbsolute(input.cwd)
          ? relative(input.sandbox.filesystemRoot, input.cwd)
          : input.cwd;
    if (
      isAbsolute(cwdRelative) ||
      Buffer.byteLength(cwdRelative) > 4_096 ||
      (cwdRelative !== "" &&
        cwdRelative
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              Buffer.byteLength(part) > 255,
          ))
    ) {
      throw new SingleProcessMacCapabilityError(
        "Cwd must be a no-follow relative directory within the held workspace",
      );
    }
    try {
      if (
        !Number.isSafeInteger(input.cwdFd) ||
        input.cwdFd < 3 ||
        !fstatSync(input.cwdFd).isDirectory()
      ) {
        throw new SingleProcessMacCapabilityError(
          "The held workspace directory descriptor is required",
        );
      }
    } catch (error) {
      if (error instanceof SingleProcessMacCapabilityError) throw error;
      throw new SingleProcessMacCapabilityError(
        "The held workspace directory descriptor is unavailable",
        error,
      );
    }
    const gitEnvironment: Record<string, string> = {};
    const maximumDeadline =
      input.environment !== undefined || input.stdin !== undefined
        ? 30_000
        : DEADLINE_MS;
    const deadlineMs = input.timeoutMs ?? maximumDeadline;
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > maximumDeadline
    ) {
      throw new SingleProcessMacCapabilityError(
        "Unsupported bounded Git command timeout",
      );
    }
    if (input.environment !== undefined || input.stdin !== undefined) {
      for (const [key, value] of Object.entries(input.environment ?? {})) {
        if (
          !["GIT_INDEX_FILE", "GIT_OPTIONAL_LOCKS"].includes(key) ||
          typeof value !== "string" ||
          value.includes("\0") ||
          Buffer.byteLength(value) > 4_096 ||
          (key === "GIT_OPTIONAL_LOCKS" && value !== "0")
        ) {
          throw new SingleProcessMacCapabilityError(
            "Unsupported private Git environment override",
          );
        }
        gitEnvironment[key] = value;
      }
      if (
        input.stdin !== undefined &&
        (typeof input.stdin !== "string" ||
          Buffer.byteLength(input.stdin) > 8 * 1024 * 1024)
      ) {
        throw new SingleProcessMacCapabilityError(
          "Canonical Git stdin exceeds its supported bound",
        );
      }
    }
    const writerLeaseFd = input.writerLease?.fd;
    if (input.writerLease !== undefined) {
      try {
        if (
          !Number.isSafeInteger(writerLeaseFd) ||
          typeof writerLeaseFd !== "number" ||
          writerLeaseFd < 3 ||
          !fstatSync(writerLeaseFd).isFile()
        ) {
          throw new SingleProcessMacCapabilityError(
            "A valid private writer-fence descriptor is required",
          );
        }
      } catch (error) {
        if (error instanceof SingleProcessMacCapabilityError) throw error;
        throw new SingleProcessMacCapabilityError(
          "The private writer-fence descriptor is unavailable",
          error,
        );
      }
    }
    input.signal.throwIfAborted();
    this.guardian = spawn(
      input.processHelperPath,
      [
        "--timeout-ms",
        String(deadlineMs),
        "--term-grace-ms",
        String(GRACE_MS),
        "--cwd-fd",
        "5",
        ...(cwdRelative === "" ? [] : ["--cwd-relative", cwdRelative]),
        ...(writerLeaseFd === undefined ? [] : ["--lease-fd", "6"]),
        "--profile",
        sandbox.profile,
        "--",
        input.executable,
        ...input.args,
      ],
      {
        detached: true,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: input.sandbox.filesystemRoot,
          TMPDIR: input.sandbox.filesystemRoot,
          LANG: "C.UTF-8",
          ...gitEnvironment,
        },
        // The guardian retains this same open description through waitpid;
        // its target closes FD6 before exec. Never reopen/unlock the fence here.
        stdio: [
          input.stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
          input.cwdFd,
          ...(writerLeaseFd === undefined ? [] : [writerLeaseFd]),
        ],
      },
    );
    // spawn can return a ChildProcess with missing pipes and report EMFILE or
    // ENFILE asynchronously. Install the failure observer before validation.
    this.guardian.on("error", () => {
      this.uncertain = true;
    });
    const stdoutStream = this.guardian.stdout;
    const stderrStream = this.guardian.stderr;
    const control = this.guardian.stdio[3];
    const status = this.guardian.stdio[4];
    if (
      !(stdoutStream instanceof Readable) ||
      !(stderrStream instanceof Readable) ||
      !(control instanceof Writable) ||
      !(status instanceof Readable)
    ) {
      for (const stream of this.guardian.stdio) {
        stream?.on("error", () => {
          this.uncertain = true;
        });
        // Drain available output/status without closing FD4 under the guardian.
        if (stream instanceof Readable && stream !== control) stream.resume();
      }
      if (control instanceof Writable) control.end("C");
      throw new SingleProcessMacCapabilityError(
        "Process guardian channels could not be established",
      );
    }
    this.control = control;
    this.result = new Promise((resolve, reject) => {
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let truncated = false;
      let statusBuffer = "";
      let statusBytes = 0;
      let settled = false;
      let inputFailure: Error | undefined;
      let inputSettled = input.stdin === undefined;
      const rejectUncertain = (message: string, cause?: unknown) => {
        this.uncertain = true;
        this.stop();
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          input.signal.removeEventListener("abort", abort);
          reject(new SingleProcessMacLifetimeUncertainError(message, cause));
        }
      };
      const finish = () => {
        if (!this.closed || !this.statusClosed || !inputSettled) return;
        clearTimeout(watchdog);
        input.signal.removeEventListener("abort", abort);
        if (settled) return;
        if (
          this.uncertain ||
          !this.cleanGuardianExit ||
          !this.receipt ||
          statusBuffer !== ""
        ) {
          rejectUncertain(
            "Process guardian exit was not verified by a complete terminal receipt",
          );
          return;
        }
        settled = true;
        if (inputFailure) {
          reject(
            new SingleProcessMacCapabilityError(
              "Canonical Git stdin could not be delivered",
              inputFailure,
            ),
          );
          return;
        }
        resolve({
          exitCode: this.receipt.exitCode,
          signal: this.receipt.signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated,
          timedOut: this.receipt.timedOut,
          outputClosed: false,
        });
      };
      const append = (target: Buffer, chunk: Buffer) => {
        const remaining = OUTPUT_BYTES - target.length;
        if (chunk.length > remaining) truncated = true;
        return remaining > 0
          ? Buffer.concat([target, chunk.subarray(0, remaining)])
          : target;
      };
      stdoutStream.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      stderrStream.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      status.on("data", (chunk: Buffer) => {
        statusBytes += chunk.length;
        if (chunk.some((byte) => byte > 127 || byte === 0)) {
          rejectUncertain("Process guardian status was not ASCII");
          return;
        }
        if (statusBytes > 1_024) {
          rejectUncertain("Process guardian status exceeded its bound");
          return;
        }
        statusBuffer += chunk.toString("ascii");
        let newline: number;
        while ((newline = statusBuffer.indexOf("\n")) !== -1) {
          const line = statusBuffer.slice(0, newline);
          statusBuffer = statusBuffer.slice(newline + 1);
          try {
            this.acceptStatus(line);
          } catch (error) {
            rejectUncertain("Process guardian status was invalid", error);
            return;
          }
        }
      });
      status.once("end", () => {
        this.statusClosed = true;
        finish();
      });
      for (const stream of [stdoutStream, stderrStream, status, control]) {
        stream.on("error", (error) =>
          rejectUncertain("Process guardian channel failed", error),
        );
      }
      this.guardian.once("error", (error) =>
        rejectUncertain("Process guardian could not be launched", error),
      );
      this.guardian.once("exit", (code, signal) => {
        this.cleanGuardianExit = code === 0 && signal === null;
      });
      this.guardian.once("close", () => {
        this.closed = true;
        finish();
      });
      const abort = () => this.stop();
      input.signal.addEventListener("abort", abort, { once: true });
      // The C guardian owns the real deadline even after this host disappears.
      // This watchdog only bounds Node's wait; it never manufactures exit proof.
      const watchdog = setTimeout(
        () => {
          rejectUncertain(
            "Process guardian terminal receipt did not arrive before the bound",
          );
          stdoutStream.destroy();
          stderrStream.destroy();
          status.destroy();
        },
        deadlineMs + GRACE_MS + 2_000,
      );
      watchdog.unref();
      if (input.stdin !== undefined) {
        const stdin = this.guardian.stdin;
        if (!(stdin instanceof Writable))
          rejectUncertain("Canonical Git stdin channel is unavailable");
        else {
          // Data only, never executable code. Wait for terminal proof even if
          // the target closes input early; input errors are not exit evidence.
          stdin.on("error", (error) => {
            inputFailure = error;
            inputSettled = true;
            finish();
          });
          stdin.once("finish", () => {
            inputSettled = true;
            finish();
          });
          stdin.once("close", () => {
            if (!inputSettled)
              inputFailure = new Error(
                "Canonical Git stdin closed before delivery completed",
              );
            inputSettled = true;
            finish();
          });
          stdin.end(input.stdin);
        }
      }
      if (input.signal.aborted) this.stop();
    });
  }

  stop(): void {
    if (this.stopped || this.closed || this.receipt) return;
    this.stopped = true;
    // Closing this pipe is also the owner-loss signal when the utility host dies.
    // Never kill the guardian: it must keep ownership until waitpid completes.
    this.control.end("C");
  }

  get quiescent(): boolean {
    return (
      this.closed &&
      this.statusClosed &&
      this.cleanGuardianExit &&
      !!this.receipt &&
      !this.uncertain
    );
  }

  private acceptStatus(line: string): void {
    const decoded: unknown = JSON.parse(line);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("Invalid guardian receipt");
    const record = decoded as Record<string, unknown>;
    if (
      record.v !== 1 ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1
    ) {
      throw new Error("Invalid guardian version or PID");
    }
    const keys = Object.keys(record).sort().join(",");
    if (record.event === "started") {
      if (
        keys !== "event,gated,pid,v" ||
        record.gated !== true ||
        this.targetPid !== undefined ||
        this.receipt
      ) {
        throw new Error("Duplicate or invalid guardian started receipt");
      }
      this.targetPid = record.pid;
      // Only the trusted, validated stopped-child receipt can release exec.
      // Never send a newline: every byte other than the first G cancels.
      if (!this.stopped && !this.uncertain) this.control.write("G");
      return;
    }
    const preStart = this.targetPid === undefined;
    const terminalKeys = preStart
      ? "event,exitCode,pid,preStart,reason,signal,v,wait"
      : "event,exitCode,pid,reason,signal,v,wait";
    if (
      record.event !== "terminal" ||
      keys !== terminalKeys ||
      (preStart && record.preStart !== true) ||
      this.receipt ||
      (this.targetPid !== undefined && record.pid !== this.targetPid) ||
      typeof record.reason !== "string" ||
      ![
        "exited",
        "cancelled",
        "owner_lost",
        "deadline",
        "guardian_error",
        "guardian_signal",
      ].includes(record.reason)
    ) {
      throw new Error("Invalid guardian terminal receipt");
    }
    if (preStart) {
      // C may reap a setup failure or cancellation before reaching SIGSTOP.
      // Require its explicit pre-start receipt: no G was sent and only an
      // observed failure/signal can settle before the stopped-child handshake.
      if (
        !(record.wait === "exited" && record.exitCode === 126) &&
        record.wait !== "signaled"
      ) {
        throw new Error(
          "Unexpected successful guardian terminal receipt before exec gate",
        );
      }
      this.targetPid = record.pid;
    }
    if (record.wait === "exited") {
      if (
        typeof record.exitCode !== "number" ||
        !Number.isSafeInteger(record.exitCode) ||
        record.exitCode < 0 ||
        record.exitCode > 255 ||
        record.signal !== null
      )
        throw new Error("Invalid guardian exit status");
      this.receipt = {
        pid: record.pid,
        exitCode: record.exitCode,
        signal: null,
        timedOut: record.reason === "deadline",
      };
      return;
    }
    if (
      record.wait !== "signaled" ||
      record.exitCode !== null ||
      typeof record.signal !== "number" ||
      !Number.isSafeInteger(record.signal) ||
      record.signal < 1
    )
      throw new Error("Invalid guardian signal status");
    const signal = Object.entries(osConstants.signals).find(
      ([, value]) => value === record.signal,
    )?.[0];
    if (!signal) throw new Error("Unknown guardian terminal signal");
    this.receipt = {
      pid: record.pid,
      exitCode: null,
      signal,
      timedOut: record.reason === "deadline",
    };
  }
}
