import { spawn } from "node:child_process";
import { lstat, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";

const RECEIPT_LIMIT = 128;
const OUTPUT_LIMIT = 1024;
const DEADLINE_MS = 5000;

export class NativeWriterFenceUnavailableError extends Error {
  readonly code = "native_writer_fence_unavailable";

  constructor() {
    super("Native writer fence acquisition is unavailable");
    this.name = "NativeWriterFenceUnavailableError";
  }
}

/**
 * The grant owner must keep this exact FileHandle open throughout this borrow
 * and for the desired fence lifetime. This adapter never closes or unlocks it.
 * An unavailable result does not prove the helper failed to acquire the lock.
 */
export async function acquireNativeWriterFence(input: {
  readonly helperPath: string;
  readonly leaseFile: FileHandle;
  readonly rootDirectory: FileHandle;
  readonly fenceDirectory: FileHandle;
  /** True only when this owner created the named inode with O_EXCL. */
  readonly initializeEmpty: boolean;
  readonly signal: AbortSignal;
}): Promise<"acquired" | "busy"> {
  const { code, receipt } = await runFenceHelper({
    helperPath: input.helperPath, signal: input.signal,
    args: ["--acquire-lease-fd", "6", "--root-fd", "5", "--namespace-fd", "7", "--initialize-empty", input.initializeEmpty ? "1" : "0"],
    pins: [
      { slot: 5, handle: input.rootDirectory, directory: true },
      { slot: 6, handle: input.leaseFile, directory: false },
      { slot: 7, handle: input.fenceDirectory, directory: true },
    ],
  });
  const acquired = Buffer.from('{"v":2,"event":"lease","state":"acquired","intentVersion":1}\n');
  const busy = Buffer.from('{"v":2,"event":"lease","state":"busy","intentVersion":1}\n');
  if (code === 0 && receipt.equals(acquired)) return "acquired";
  if (code === 75 && receipt.equals(busy)) return "busy";
  throw new NativeWriterFenceUnavailableError();
}

/** The same bounded original-helper lifetime, before advertising writer support.
 * The native probe touches no workspace, provider or real writer lease. */
export async function probeNativeWriterIntentABI(input: {
  readonly helperPath: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const { code, receipt } = await runFenceHelper({ ...input, args: ["--probe-writer-intent"], pins: [] });
  return code === 0 && receipt.equals(Buffer.from(
    '{"v":2,"event":"intent_probe","state":"supported","intentVersion":1}\n',
  ));
}

type BorrowedPin = { readonly slot: number; readonly handle: FileHandle; readonly directory: boolean };

async function runFenceHelper(input: {
  readonly helperPath: string; readonly signal: AbortSignal;
  readonly args: readonly string[]; readonly pins: readonly BorrowedPin[];
}): Promise<{ readonly code: number | null; readonly receipt: Buffer }> {
  const { helperPath, signal, pins } = input;
  try {
    if (
      signal.aborted ||
      !isAbsolute(helperPath) ||
      helperPath.includes("\0")
    ) {
      throw new NativeWriterFenceUnavailableError();
    }
    if ((await realpath(helperPath)) !== helperPath) {
      throw new NativeWriterFenceUnavailableError();
    }
    const helper = await lstat(helperPath);
    if (
      !helper.isFile() ||
      helper.isSymbolicLink() ||
      (helper.mode & 0o022) !== 0 ||
      (helper.mode & 0o111) === 0 ||
      (helper.uid !== 0 && helper.uid !== process.geteuid?.())
    ) {
      throw new NativeWriterFenceUnavailableError();
    }
    // Retain the actual handle objects through every await and helper close.
    for (const pin of pins) {
      const stat = await pin.handle.stat();
      if (pin.directory ? !stat.isDirectory() : !stat.isFile()) throw new NativeWriterFenceUnavailableError();
    }
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe", "ignore", "pipe"];
    const descriptors = pins.map((pin) => {
      const descriptor = pin.handle.fd;
      if (descriptor < 0) throw new NativeWriterFenceUnavailableError();
      stdio[pin.slot] = descriptor;
      return descriptor;
    });
    if (signal.aborted) throw new NativeWriterFenceUnavailableError();
    // No await between capturing each borrowed handle's current FD and inheritance.
    const child = spawn(helperPath, [...input.args], {
      stdio, env: {}, shell: false, windowsHide: true,
    });
    let failed = false;
    let stopping = false;
    let receipt = Buffer.alloc(0);
    const stop = () => {
      failed = true;
      if (stopping) return;
      stopping = true;
      // Lock-only mode never forks an untrusted target. Kill only this helper.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // A failed kill is not closure: continue awaiting the real close event.
        }
      }
    };
    // Spawn failure can return missing pipes and emit error asynchronously.
    // Observe both events before inspecting any optional pipe.
    child.on("error", stop);
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      // Unlike exit, close observes actual helper exit and all inherited pipes.
      child.once("close", (code, exitSignal) =>
        resolve({ code, signal: exitSignal }),
      );
    });
    const readBounded = (stream: Readable, limit: number, save: boolean) => {
      let bytes = 0;
      stream.on("error", stop);
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          stop();
        } else if (save) {
          receipt = Buffer.concat([receipt, chunk]);
        }
      });
    };
    // Drain all pipes; bounded receipt storage never includes diagnostics.
    const status = child.stdio[4];
    for (const [stream, limit, save] of [
      [status, RECEIPT_LIMIT, true],
      [child.stdout, OUTPUT_LIMIT, false],
      [child.stderr, OUTPUT_LIMIT, false],
    ] as const) {
      if (stream instanceof Readable) readBounded(stream, limit, save);
      else stop();
    }
    const timer = setTimeout(stop, DEADLINE_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    let outcome: Awaited<typeof closed>;
    try {
      outcome = await closed;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
    if (
      failed ||
      signal.aborted ||
      outcome.signal !== null ||
      pins.some((pin, index) => pin.handle.fd !== descriptors[index])
    ) {
      throw new NativeWriterFenceUnavailableError();
    }
    return { code: outcome.code, receipt };
  } catch {
    throw new NativeWriterFenceUnavailableError();
  }
}
