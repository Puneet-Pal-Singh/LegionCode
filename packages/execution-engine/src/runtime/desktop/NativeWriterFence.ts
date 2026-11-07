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
  readonly signal: AbortSignal;
}): Promise<"acquired" | "busy"> {
  // Retain the handle object, not just a descriptor captured before async prep.
  const { helperPath, leaseFile, signal } = input;
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
    // fstat validates file type; it does not prove open-description/lock identity.
    const lease = await leaseFile.stat();
    const descriptor = leaseFile.fd;
    if (signal.aborted || !lease.isFile() || descriptor < 0) {
      throw new NativeWriterFenceUnavailableError();
    }
    // No await between reading the borrowed handle's current FD and inheritance.
    const child = spawn(helperPath, ["--acquire-lease-fd", "6"], {
      stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "ignore", descriptor],
      env: {},
      shell: false,
      windowsHide: true,
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
      leaseFile.fd !== descriptor
    ) {
      throw new NativeWriterFenceUnavailableError();
    }
    // The trusted C ABI emits exactly one ASCII frame, with no trailing bytes.
    const acquired = Buffer.from(
      '{"v":1,"event":"lease","state":"acquired"}\n',
    );
    const busy = Buffer.from('{"v":1,"event":"lease","state":"busy"}\n');
    if (outcome.code === 0 && receipt.equals(acquired)) return "acquired";
    if (outcome.code === 75 && receipt.equals(busy)) return "busy";
    throw new NativeWriterFenceUnavailableError();
  } catch {
    throw new NativeWriterFenceUnavailableError();
  }
}
