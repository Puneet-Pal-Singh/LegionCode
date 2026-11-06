import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export class NativeFilesystemError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Private LCFM/1 bridge. Trusted composition supplies the executable and root FD.
 * No shell, provider secrets, lifecycle writes or path-magic fallback. Every
 * operation awaits actual child/pipe closure, including native cleanup.
 */
export class NativeFilesystemBridge {
  constructor(
    private readonly options: {
      readonly helperPath: string;
      readonly rootDirectory: FileHandle;
      /** Borrowed canonical writer lease; never acquired, unlocked or closed here. */
      readonly writerLease?: { readonly fd: number };
    },
  ) {}

  async readFile(input: {
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<{ path: string; content: string; bytes: number }> {
    return this.withHelper("R", input, async (reader) => {
      const original = await inspect(reader);
      if (!original.exists)
        throw new NativeFilesystemError(5, "Workspace file does not exist");
      input.signal.throwIfAborted();
      return {
        path: input.path,
        content: decode(original.bytes),
        bytes: original.bytes.length,
      };
    });
  }

  async mutate(input: {
    readonly path: string;
    readonly prepare: (current: string | null) => string;
    readonly beforeCommit: (signal: AbortSignal) => Promise<void>;
    readonly signal: AbortSignal;
  }): Promise<{ path: string; bytes: number; created: boolean }> {
    return this.withHelper("M", input, async (reader, stdin) => {
      const original = await inspect(reader);
      input.signal.throwIfAborted();
      let prepared: string;
      try {
        prepared = input.prepare(
          original.exists ? decode(original.bytes) : null,
        );
      } catch (error) {
        throw new NativeFilesystemError(
          5,
          error instanceof Error
            ? error.message
            : "Unable to prepare file mutation",
        );
      }
      const next = Buffer.from(prepared, "utf8");
      if (next.byteLength > MAX_FILE_BYTES)
        throw new NativeFilesystemError(
          5,
          "Local mutation exceeds the 4 MiB supported limit",
        );
      await send(
        stdin,
        Buffer.concat([Buffer.from("S"), u32(next.length), next]),
      );
      await reader.tag(83);
      // The helper has only staged bytes. Revalidate runtime authority before commit.
      await awaitAuthorization(
        () => input.beforeCommit(input.signal),
        input.signal,
      );
      input.signal.throwIfAborted();
      await send(stdin, Buffer.from("C"));
      await reader.tag(67);
      return {
        path: input.path,
        bytes: next.length,
        created: !original.exists,
      };
    });
  }

  private async withHelper<T>(
    operation: "R" | "M",
    input: { path: string; signal: AbortSignal },
    run: (reader: FrameReader, stdin: Writable) => Promise<T>,
  ): Promise<T> {
    validateLocalFilesystemPath(input.path);
    if (
      !isAbsolute(this.options.helperPath) ||
      this.options.helperPath.includes("\0")
    ) {
      throw new NativeFilesystemError(
        5,
        "Native filesystem helper requires a trusted absolute executable path",
      );
    }
    const executable = await lstat(this.options.helperPath);
    if (
      !executable.isFile() ||
      executable.isSymbolicLink() ||
      (executable.mode & 0o022) !== 0
    ) {
      throw new NativeFilesystemError(
        5,
        "Native filesystem helper must be a protected regular executable",
      );
    }
    if (!(await this.options.rootDirectory.stat()).isDirectory()) {
      throw new NativeFilesystemError(
        5,
        "Native filesystem requires the trusted grant root directory FD",
      );
    }
    const leaseFd = this.options.writerLease?.fd;
    if (operation === "M") {
      if (!Number.isSafeInteger(leaseFd) || leaseFd! < 4 || !fstatSync(leaseFd!).isFile()) {
        throw new NativeFilesystemError(5, "Mutation requires the trusted canonical writer lease descriptor");
      }
    }
    input.signal.throwIfAborted();
    const child = spawn(this.options.helperPath, [], {
      // FD6 duplicates the SAME open description, retaining its physical lock
      // through native cleanup even if the utility process dies. No new lease.
      stdio: operation === "M"
        ? ["pipe", "pipe", "pipe", this.options.rootDirectory.fd, "ignore", "ignore", leaseFd!]
        : ["pipe", "pipe", "pipe", this.options.rootDirectory.fd],
      env: {},
      shell: false,
      windowsHide: true,
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let error: Error | undefined;
      child.once("error", (cause) => {
        error = cause;
      });
      child.once("close", (code, signal) =>
        resolve({ code, signal, ...(error ? { error } : {}) }),
      );
    });
    const stdin = child.stdin!,
      stdout = child.stdout!,
      stderr = child.stderr!;
    const stop = () => {
      child.kill("SIGTERM");
    };
    stdin.on("error", stop);
    stderr.on("error", stop);
    stderr.resume();
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    const reader = new FrameReader(stdout[Symbol.asyncIterator]());
    let completed = false;
    try {
      const path = Buffer.from(input.path, "utf8");
      await send(
        stdin,
        Buffer.concat([
          Buffer.from([76, 67, 70, 77, 1, operation.charCodeAt(0)]),
          u32(path.length),
          path,
        ]),
      );
      const result = await run(reader, stdin);
      stdin.end();
      const outcome = await closed;
      if (outcome.error || outcome.signal !== null || outcome.code !== 0)
        throw new NativeFilesystemError(
          3,
          "Native filesystem operation did not exit cleanly; mutation capture must settle actual state",
        );
      completed = true;
      return result;
    } catch (error) {
      if (error instanceof NativeFilesystemError) throw error;
      throw new NativeFilesystemError(
        3,
        "Native filesystem transport or authorization failed; mutation capture must settle actual state",
      );
    } finally {
      input.signal.removeEventListener("abort", stop);
      if (!completed) stop();
      stdin.end();
      // A failed callback stops parsing. Close its output pipe so unread error
      // bytes cannot strand close; native SIGPIPE/EPIPE still runs cleanup.
      stdout.destroy();
      // Never fabricate quiescence while a syscall, cleanup or child remains active.
      const outcome = await closed;
      if (
        outcome.error ||
        outcome.signal !== null ||
        (outcome.code !== 0 && outcome.code !== 1) ||
        (reader.receivedError && outcome.code !== 1)
      )
        throw new NativeFilesystemError(
          3,
          "Native filesystem cleanup failed; workspace capture is required",
        );
    }
  }
}

export function validateLocalFilesystemPath(path: string): void {
  if (
    !path ||
    Buffer.byteLength(path, "utf8") > 500 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    Buffer.from(path, "utf8").toString("utf8") !== path
  ) {
    throw new NativeFilesystemError(
      1,
      "Native filesystem requires a bounded relative UTF-8 workspace path",
    );
  }
  if (
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          part.toLowerCase().startsWith(".legioncode-edit-"),
      )
  ) {
    throw new NativeFilesystemError(
      1,
      "Path is outside the supported workspace boundary",
    );
  }
}

async function inspect(
  reader: FrameReader,
): Promise<{ exists: boolean; bytes: Buffer }> {
  await reader.tag(73);
  const exists = (await reader.read(1))[0];
  if (exists !== 0 && exists !== 1)
    throw new Error("Invalid native source state");
  const length = await reader.length(MAX_FILE_BYTES);
  if (!exists && length !== 0) throw new Error("Invalid missing-file frame");
  return { exists: exists === 1, bytes: await reader.read(length) };
}

function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

class FrameReader {
  receivedError = false;
  private buffered = Buffer.alloc(0);
  constructor(private readonly source: AsyncIterator<Buffer | string>) {}

  async read(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES)
      throw new Error("Invalid native frame length");
    while (this.buffered.length < length) {
      const part = await this.source.next();
      if (part.done)
        throw new Error("Native filesystem helper closed before its receipt");
      const chunk = Buffer.isBuffer(part.value)
        ? part.value
        : Buffer.from(part.value);
      if (this.buffered.length + chunk.length > MAX_FILE_BYTES + 1024)
        throw new Error("Native filesystem helper exceeded protocol bounds");
      this.buffered = Buffer.concat([this.buffered, chunk]);
    }
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  async length(maximum: number): Promise<number> {
    const value = (await this.read(4)).readUInt32BE(0);
    if (value > maximum)
      throw new Error("Native filesystem frame exceeds its limit");
    return value;
  }

  async tag(expected: number): Promise<void> {
    const tag = (await this.read(1))[0];
    if (tag === 69) {
      const code = (await this.read(1))[0]!;
      if (code < 1 || code > 5) throw new Error("Invalid native error receipt");
      this.receivedError = true;
      const length = await this.length(1024);
      throw new NativeFilesystemError(
        code,
        (await this.read(length)).toString("utf8"),
      );
    }
    if (tag !== expected)
      throw new Error("Native filesystem protocol state mismatch");
  }
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function send(pipe: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    pipe.write(bytes, (error?: Error | null) =>
      error ? reject(error) : resolve(),
    );
  });
}

function awaitAuthorization(
  check: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (outcome: { ok: true } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (outcome.ok) resolve();
      else reject(outcome.error);
    };
    const abort = () =>
      finish({
        ok: false,
        error: new NativeFilesystemError(
          4,
          "Native commit authorization was cancelled",
        ),
      });
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: new NativeFilesystemError(
            3,
            "Native commit authorization timed out",
          ),
        }),
      10_000,
    );
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return check();
      })
      .then(
        () => finish({ ok: true }),
        (error: unknown) => finish({ ok: false, error }),
      );
    if (signal.aborted) abort();
  });
}
