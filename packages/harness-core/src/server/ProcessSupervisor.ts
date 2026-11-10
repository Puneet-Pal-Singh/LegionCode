import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HarnessHostError } from "./errors.js";

export interface ProcessLaunch {
  readonly processGeneration: string;
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
      readonly verification: "group_absent" | "linux_zombie_group";
      readonly processGeneration: string;
      readonly checkedAt: string;
    }
  | {
      readonly kind: "unknown";
      readonly processGeneration: string;
      readonly reason: "timeout" | "inspection_failed";
    };

/** Pipe closure does not establish child/descendant confinement or canonical ACK drain. */
export type ProcessOutputClosure =
  | {
      readonly kind: "natural_eof";
      readonly processGeneration: string;
      readonly checkedAt: string;
    }
  | {
      readonly kind: "unknown";
      readonly processGeneration: string;
      readonly reason:
        | "timeout"
        | "output_error"
        | "output_closed_early"
        | "spawn_failed";
    };

export interface SupervisedProcess {
  readonly processGeneration: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly exited: Promise<ProcessExit>;
  /** Non-destructive wait for natural stdout AND stderr EOF. No resume/destroy
   * side effects. An absent receipt port cannot establish output closure. */
  awaitOutputClosure?(input: {
    readonly timeoutMs: number;
  }): Promise<ProcessOutputClosure>;
  /** No raw stderr is exported or logged. A caller's redactor sees only a bounded tail. */
  readStderr(redact: (tail: string) => string): string;
  terminate(input: {
    readonly graceMs: number;
    readonly killWaitMs: number;
  }): Promise<ProcessGroupSettlement>;
}

export class ProcessSupervisor {
  private readonly processes = new Set<SupervisedProcess>();

  constructor(private readonly maxProcesses = 16) {
    if (
      !Number.isSafeInteger(maxProcesses) ||
      maxProcesses < 1 ||
      maxProcesses > 256
    )
      throw new HarnessHostError("invalid_launch");
  }

  launch(spec: ProcessLaunch): SupervisedProcess {
    if (this.processes.size >= this.maxProcesses)
      throw new HarnessHostError("session_busy");
    if (process.platform === "win32")
      throw new HarnessHostError("unsupported_platform");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        spec.processGeneration,
      ) ||
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
    const processGeneration = spec.processGeneration;
    let groupSettlement: ProcessGroupSettlement | undefined;
    let exitReceipt: ProcessExit | undefined;
    let outputClosure: ProcessOutputClosure | undefined;
    let resolveOutputClosed!: (closure: ProcessOutputClosure) => void;
    const outputClosed = new Promise<ProcessOutputClosure>((resolve) => {
      resolveOutputClosed = resolve;
    });
    let stdoutEnded = false;
    let stderrEnded = false;
    const releaseClosedProcess = () => {
      if (groupSettlement?.kind !== "process_group_quiesced") return;
      const neverSpawned =
        exitReceipt?.kind === "spawn_failed" &&
        child.pid === undefined &&
        groupSettlement.verification === "group_absent";
      // A confirmed never-spawned child can release capacity without inventing
      // natural EOF. Any possibly-live process still needs the output barrier.
      if (!neverSpawned && outputClosure?.kind !== "natural_eof") return;
      this.processes.delete(supervised);
      stderr = Buffer.alloc(0);
      child.stdin.destroy();
    };
    const recordOutputClosure = (closure: ProcessOutputClosure) => {
      if (outputClosure) return;
      outputClosure = Object.freeze(closure);
      resolveOutputClosed(outputClosure);
      releaseClosedProcess();
    };
    const ended = () => {
      if (stdoutEnded && stderrEnded)
        recordOutputClosure({
          kind: "natural_eof",
          processGeneration,
          checkedAt: new Date().toISOString(),
        });
    };
    child.stdout.once("end", () => {
      stdoutEnded = true;
      ended();
    });
    child.stderr.once("end", () => {
      stderrEnded = true;
      ended();
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.once("close", () => {
        if (!stream.readableEnded)
          recordOutputClosure({
            kind: "unknown",
            processGeneration,
            reason: "output_closed_early",
          });
      });
      stream.on("error", () =>
        recordOutputClosure({
          kind: "unknown",
          processGeneration,
          reason: "output_error",
        }),
      );
    }
    child.once("error", () =>
      recordOutputClosure({
        kind: "unknown",
        processGeneration,
        reason: "spawn_failed",
      }),
    );
    let stderr = Buffer.alloc(0);
    const maxStderrBytes = 16 * 1024;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-maxStderrBytes);
    });
    const exited = new Promise<ProcessExit>((resolve) => {
      const settle = (receipt: ProcessExit) => {
        if (exitReceipt) return;
        exitReceipt = Object.freeze(receipt);
        resolve(exitReceipt);
        releaseClosedProcess();
      };
      child.once("error", () => settle({ kind: "spawn_failed" }));
      child.once("exit", (code, signal) =>
        settle({ kind: "exited", code, signal }),
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
      awaitOutputClosure: async ({ timeoutMs }) => {
        validateDuration(timeoutMs);
        if (outputClosure) return outputClosure;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            outputClosed,
            new Promise<ProcessOutputClosure>((resolve) => {
              timer = setTimeout(
                () =>
                  resolve({
                    kind: "unknown",
                    processGeneration,
                    reason: "timeout",
                  }),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      readStderr: (redact) => redact(stderr.toString("utf8")),
      terminate: (input) => {
        validateDuration(input.graceMs);
        validateDuration(input.killWaitMs);
        if (!termination) {
          termination = terminateGroup(child, processGeneration, input).then(
            (result) => {
              if (result.kind === "process_group_quiesced") {
                groupSettlement = result;
                // Never destroy readable pipes to manufacture EOF. Buffered frames
                // and descendant-held descriptors must drain through their consumers.
                releaseClosedProcess();
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
      verification: "group_absent",
      processGeneration,
      checkedAt: new Date().toISOString(),
    };
  try {
    signalGroup(pid, "SIGTERM");
    let verification = await awaitGroupExit(pid, input.graceMs);
    if (!verification) {
      signalGroup(pid, "SIGKILL");
      verification = await awaitGroupExit(pid, input.killWaitMs);
      if (!verification)
        return { kind: "unknown", processGeneration, reason: "timeout" };
    }
    return {
      kind: "process_group_quiesced",
      verification,
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
): Promise<"group_absent" | "linux_zombie_group" | null> {
  const deadline = performance.now() + timeoutMs;
  let previousZombies: string | undefined;
  while (signalGroup(pid, 0)) {
    if (process.platform === "linux") {
      const snapshot = await linuxZombieGroup(pid);
      // Two identical all-zombie snapshots prevent accepting a fork racing the /proc listing.
      if (snapshot !== null && snapshot === previousZombies)
        return "linux_zombie_group";
      previousZombies = snapshot ?? undefined;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    await delay(Math.min(25, remaining));
  }
  return "group_absent";
}

async function linuxZombieGroup(group: number): Promise<string | null> {
  const members: string[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let raw: string;
    try {
      raw = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ESRCH")
      )
        continue;
      throw error;
    }
    const fields = raw
      .slice(raw.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/);
    if (fields.length < 20) throw new HarnessHostError("process_not_quiescent");
    if (Number(fields[2]) !== group) continue;
    if (fields[0] !== "Z" && fields[0] !== "X") return null;
    members.push(`${pid}:${fields[19]}:${fields[0]}`);
  }
  // kill(0) said the group exists: an empty inspection is not usable evidence.
  return members.length ? members.sort().join(",") : null;
}
