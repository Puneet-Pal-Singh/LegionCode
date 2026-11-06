import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HarnessHostError } from "./errors.js";

export interface ProcessLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  /** Already resolved and authorized by host launch policy. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly uid?: number;
  readonly gid?: number;
}

export type ProcessExit =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "spawn_failed" };

/** Group evidence is not proof against setsid escape: composition must enforce the OS boundary. */
export type ProcessGroupSettlement =
  | {
      readonly kind: "process_group_quiesced";
      readonly processGeneration: string;
      readonly checkedAt: string;
    }
  | {
      readonly kind: "unknown";
      readonly processGeneration: string;
      readonly reason: "timeout" | "inspection_failed";
    };

export interface SupervisedProcess {
  readonly processGeneration: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly exited: Promise<ProcessExit>;
  /** No raw stderr is exported or logged. A caller's redactor sees only a bounded tail. */
  readStderr(redact: (tail: string) => string): string;
  terminate(input: {
    readonly graceMs: number;
    readonly killWaitMs: number;
  }): Promise<ProcessGroupSettlement>;
}

export class ProcessSupervisor {
  private readonly processes = new Set<SupervisedProcess>();

  launch(spec: ProcessLaunch): SupervisedProcess {
    if (process.platform === "win32")
      throw new HarnessHostError("unsupported_platform");
    if (
      !isAbsolute(spec.executable) ||
      !isAbsolute(spec.cwd) ||
      spec.executable.includes("\0") ||
      spec.args.some((arg) => arg.includes("\0")) ||
      Object.values(spec.env).some((value) => value.includes("\0")) ||
      (spec.uid !== undefined &&
        (!Number.isSafeInteger(spec.uid) || spec.uid <= 0)) ||
      (spec.gid !== undefined &&
        (!Number.isSafeInteger(spec.gid) || spec.gid < 0))
    ) {
      throw new HarnessHostError("invalid_launch");
    }
    // An explicit env and direct argv avoid ambient credentials and shell interpolation.
    const child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      uid: spec.uid,
      gid: spec.gid,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const processGeneration = randomUUID();
    let stderr = Buffer.alloc(0);
    const maxStderrBytes = 16 * 1024;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-maxStderrBytes);
    });
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once("error", () => resolve({ kind: "spawn_failed" }));
      child.once("exit", (code, signal) =>
        resolve({ kind: "exited", code, signal }),
      );
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new HarnessHostError("invalid_launch")));
    });
    // A concurrent immediate Stop may own the failure before the driver awaits readiness.
    void ready.catch(() => undefined);
    let termination: Promise<ProcessGroupSettlement> | undefined;
    const supervised: SupervisedProcess = {
      processGeneration,
      child,
      ready,
      exited,
      readStderr: (redact) => redact(stderr.toString("utf8")),
      terminate: (input) => {
        validateDuration(input.graceMs);
        validateDuration(input.killWaitMs);
        if (!termination) {
          termination = terminateGroup(child, processGeneration, input).then(
            (result) => {
              if (result.kind === "process_group_quiesced") {
                this.processes.delete(supervised);
                stderr = Buffer.alloc(0);
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
              }
              if (result.kind === "unknown") termination = undefined;
              return result;
            },
          );
        }
        return termination;
      },
    };
    // Retain after parent exit: descendants may still be writing the workspace.
    this.processes.add(supervised);
    return supervised;
  }

  async terminateAll(input: {
    readonly graceMs: number;
    readonly killWaitMs: number;
  }): Promise<readonly ProcessGroupSettlement[]> {
    return Promise.all(
      [...this.processes].map((child) => child.terminate(input)),
    );
  }
}

function validateDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000)
    throw new HarnessHostError("invalid_launch");
}

async function terminateGroup(
  child: ChildProcessWithoutNullStreams,
  processGeneration: string,
  input: { readonly graceMs: number; readonly killWaitMs: number },
): Promise<ProcessGroupSettlement> {
  const pid = child.pid;
  if (pid === undefined)
    return {
      kind: "process_group_quiesced",
      processGeneration,
      checkedAt: new Date().toISOString(),
    };
  try {
    signalGroup(pid, "SIGTERM");
    if (!(await awaitGroupExit(pid, input.graceMs))) {
      signalGroup(pid, "SIGKILL");
      if (!(await awaitGroupExit(pid, input.killWaitMs)))
        return { kind: "unknown", processGeneration, reason: "timeout" };
    }
    return {
      kind: "process_group_quiesced",
      processGeneration,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return { kind: "unknown", processGeneration, reason: "inspection_failed" };
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function awaitGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (signalGroup(pid, 0)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}
