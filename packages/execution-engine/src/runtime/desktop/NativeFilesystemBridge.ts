import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
/** Physical closure of this trusted helper, which never forks or execs. */
export interface NativeFilesystemExecution {
  readonly closed: Promise<void>;
  readonly quiescent: boolean;
}

/** Opaque physical identity; persist the string, parse before trusted comparison. */
export type NativeGitMetadataIdentity = string;
export function parseNativeGitMetadataIdentity(
  value: unknown,
): NativeGitMetadataIdentity {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^gitdir-v1(?::[0-9a-f]{1,16}){8}$/u.test(value)
  )
    throw new NativeFilesystemError(1, "Invalid native Git metadata identity");
  return value;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_CURSOR_CHARS = 16 * 1024;

export interface NativeDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  /** The listed object's own stat size, never a symlink target or recursive size. */
  readonly bytes: number;
  readonly mode: number;
  /** Visible user entry in a pre-existing reserved path namespace; not openable. */
  readonly unavailableReason?: "reserved_path";
}
export interface NativeDirectoryPage {
  readonly path: string;
  readonly entries: readonly NativeDirectoryEntry[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}
interface DirectoryCursor {
  v: 1;
  path: string;
  version: string;
  after: string;
}

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
      readonly observeExecution?: (
        execution: NativeFilesystemExecution,
      ) => void;
    },
  ) {}

  /** Read-only inspection of normal .git metadata through the original root FD.
   * Linked-worktree files and metadata symlinks are explicitly unsupported. */
  async inspectGitMetadataIdentity(input: {
    readonly signal: AbortSignal;
  }): Promise<NativeGitMetadataIdentity> {
    return this.withHelper(
      "I",
      { path: ".git", signal: input.signal },
      async (reader) => {
        await reader.tag(74);
        const bytes = await reader.read(await reader.length(256));
        if (bytes.some((value) => value > 127))
          throw new NativeFilesystemError(
            1,
            "Invalid native metadata identity encoding",
          );
        input.signal.throwIfAborted();
        return parseNativeGitMetadataIdentity(bytes.toString("ascii"));
      },
    );
  }

  async readBytes(input: {
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<{ path: string; content: Uint8Array; bytes: number }> {
    return this.withHelper("R", input, async (reader) => {
      const original = await inspect(reader);
      if (!original.exists)
        throw new NativeFilesystemError(5, "Workspace file does not exist");
      input.signal.throwIfAborted();
      return {
        path: input.path,
        content: original.bytes,
        bytes: original.bytes.length,
      };
    });
  }

  async readFile(input: {
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<{ path: string; content: string; bytes: number }> {
    const result = await this.readBytes(input);
    return { ...result, content: decode(result.content) };
  }

  async listDirectory(input: {
    readonly path: string;
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly signal: AbortSignal;
  }): Promise<NativeDirectoryPage> {
    const limit = input.limit ?? MAX_DIRECTORY_ENTRIES;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DIRECTORY_ENTRIES
    ) {
      throw new NativeFilesystemError(
        1,
        "Directory limit must be an integer from 1 to 200",
      );
    }
    const cursor = parseDirectoryCursor(input.cursor, input.path);
    return this.withHelper("D", input, async (reader, stdin) => {
      const versionBytes = Buffer.from(cursor?.version ?? "", "ascii");
      const afterBytes = Buffer.from(cursor?.after ?? "", "utf8");
      await send(
        stdin,
        Buffer.concat([
          u32(limit),
          u32(versionBytes.length),
          versionBytes,
          u32(afterBytes.length),
          afterBytes,
        ]),
      );
      await reader.tag(68);
      const truncated = (await reader.read(1))[0];
      if (truncated !== 0 && truncated !== 1)
        throw new Error("Invalid directory truncation flag");
      const versionBuffer = await reader.read(await reader.length(192));
      const version = versionBuffer.toString("utf8");
      if (
        !validDirectoryVersion(version) ||
        Buffer.byteLength(version) !== versionBuffer.length
      )
        throw new Error("Invalid directory version");
      const count = await reader.length(limit);
      const entries: NativeDirectoryEntry[] = [];
      let wireBytes = 10 + versionBuffer.length;
      for (let index = 0; index < count; index++) {
        const kindByte = (await reader.read(1))[0];
        const kind =
          kindByte === 102
            ? "file"
            : kindByte === 100
              ? "directory"
              : kindByte === 108
                ? "symlink"
                : kindByte === 111
                  ? "other"
                  : null;
        if (!kind) throw new Error("Invalid directory entry kind");
        const nameBytes = await reader.read(await reader.length(1024));
        const name = decode(nameBytes);
        if (!validDirectoryName(name))
          throw new NativeFilesystemError(
            5,
            "Directory contains an unsupported filename",
          );
        wireBytes += 17 + nameBytes.length;
        if (wireBytes > MAX_DIRECTORY_BYTES)
          throw new Error("Native directory response exceeded its byte budget");
        const size = (await reader.read(8)).readBigUInt64BE(0);
        if (size > BigInt(Number.MAX_SAFE_INTEGER))
          throw new NativeFilesystemError(
            5,
            "Directory entry size exceeds safe JSON precision",
          );
        const mode = (await reader.read(4)).readUInt32BE(0);
        if (mode > 0o7777) throw new Error("Invalid directory entry mode");
        if (
          entries.length &&
          Buffer.compare(
            Buffer.from(entries[entries.length - 1]!.name),
            nameBytes,
          ) >= 0
        )
          throw new Error("Directory entries are not strictly ordered");
        const path = input.path === "." ? name : `${input.path}/${name}`;
        if (Buffer.byteLength(path, "utf8") > 500)
          throw new NativeFilesystemError(
            5,
            "Directory entry exceeds the 500-byte native path limit",
          );
        entries.push({
          name,
          path,
          kind,
          bytes: Number(size),
          mode,
          ...(reservedComponent(name)
            ? { unavailableReason: "reserved_path" as const }
            : {}),
        });
      }
      input.signal.throwIfAborted();
      return boundedDirectoryPage(
        input.path,
        version,
        entries,
        truncated === 1,
      );
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
    operation: "R" | "M" | "D" | "I",
    input: { path: string; signal: AbortSignal },
    run: (reader: FrameReader, stdin: Writable) => Promise<T>,
  ): Promise<T> {
    if (operation !== "I")
      validateLocalFilesystemPath(input.path, operation === "D");
    else if (input.path !== ".git")
      throw new NativeFilesystemError(
        1,
        "Unsupported metadata identity target",
      );
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
      if (
        !Number.isSafeInteger(leaseFd) ||
        leaseFd! < 4 ||
        !fstatSync(leaseFd!).isFile()
      ) {
        throw new NativeFilesystemError(
          5,
          "Mutation requires the trusted canonical writer lease descriptor",
        );
      }
    }
    input.signal.throwIfAborted();
    const child = spawn(this.options.helperPath, [], {
      // FD6 duplicates the SAME open description through native cleanup.
      stdio:
        operation === "M"
          ? [
              "pipe",
              "pipe",
              "pipe",
              this.options.rootDirectory.fd,
              "ignore",
              "ignore",
              leaseFd!,
            ]
          : ["pipe", "pipe", "pipe", this.options.rootDirectory.fd],
      env: {},
      shell: false,
      windowsHide: true,
    });
    let physicallyClosed = false;
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let error: Error | undefined;
      child.once("error", (cause) => {
        error = cause;
      });
      child.once("close", (code, signal) => {
        physicallyClosed = true;
        resolve({ code, signal, ...(error ? { error } : {}) });
      });
    });
    const execution: NativeFilesystemExecution = {
      closed: closed.then(() => undefined),
      get quiescent() {
        return physicallyClosed;
      },
    };
    const closeFailedSetup = async () => {
      // Even failed spawn/channel setup can have an owned child. Observe it
      // before accessing pipes, drain available channels, then await real close.
      for (const stream of child.stdio) {
        stream?.on("error", () => undefined);
        if (stream instanceof Readable) stream.resume();
      }
      if (child.stdin instanceof Writable) child.stdin.end();
      child.kill("SIGTERM");
      await closed;
    };
    try {
      this.options.observeExecution?.(execution);
    } catch {
      await closeFailedSetup();
      throw new NativeFilesystemError(
        3,
        "Native filesystem lifetime observer failed after spawn",
      );
    }
    const stdin = child.stdin,
      stdout = child.stdout,
      stderr = child.stderr;
    if (
      !(stdin instanceof Writable) ||
      !(stdout instanceof Readable) ||
      !(stderr instanceof Readable)
    ) {
      await closeFailedSetup();
      throw new NativeFilesystemError(
        3,
        "Native filesystem channels were not established",
      );
    }
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

export function validateLocalFilesystemPath(
  path: string,
  allowRoot = false,
): void {
  if (allowRoot && path === ".") return;
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

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new NativeFilesystemError(
      5,
      "Native filesystem supports UTF-8 text only; use readBytes for binary data",
    );
  }
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

function validDirectoryVersion(version: string): boolean {
  return (
    Buffer.byteLength(version, "utf8") <= 192 &&
    /^[0-9a-f]+:[0-9a-f]+:-?\d+:\d+:-?\d+:\d+$/.test(version)
  );
}
function validDirectoryName(name: string): boolean {
  return (
    !!name &&
    Buffer.byteLength(name, "utf8") <= 1024 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.toLowerCase() !== ".git" &&
    !/^\.legioncode-edit-[0-9a-f]{32}\.tmp$/i.test(name) &&
    Buffer.from(name, "utf8").toString("utf8") === name
  );
}
function parseDirectoryCursor(
  raw: string | null | undefined,
  path: string,
): DirectoryCursor | null {
  if (raw === null || raw === undefined) return null;
  try {
    if (typeof raw !== "string" || !raw || raw.length > MAX_CURSOR_CHARS)
      throw new Error();
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error();
    const value: unknown = JSON.parse(decode(bytes));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "after,path,v,version"
    )
      throw new Error();
    const candidate = value as Record<string, unknown>;
    if (
      candidate.v !== 1 ||
      candidate.path !== path ||
      typeof candidate.version !== "string" ||
      !validDirectoryVersion(candidate.version) ||
      typeof candidate.after !== "string" ||
      !validDirectoryName(candidate.after)
    )
      throw new Error();
    return { v: 1, path, version: candidate.version, after: candidate.after };
  } catch {
    throw new NativeFilesystemError(
      1,
      "Invalid directory cursor for this path",
    );
  }
}
function boundedDirectoryPage(
  path: string,
  version: string,
  source: NativeDirectoryEntry[],
  nativeTruncated: boolean,
): NativeDirectoryPage {
  const entries = [...source];
  for (;;) {
    const truncated = nativeTruncated || entries.length < source.length;
    if (truncated && !entries.length)
      throw new NativeFilesystemError(
        5,
        "Directory entry cannot fit the response byte budget",
      );
    const cursor: DirectoryCursor | null = truncated
      ? { v: 1, path, version, after: entries[entries.length - 1]!.name }
      : null;
    const nextCursor = cursor
      ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
      : null;
    if (nextCursor && nextCursor.length > MAX_CURSOR_CHARS)
      throw new NativeFilesystemError(
        5,
        "Directory cursor exceeds its supported bound",
      );
    const page = { path, entries, truncated, nextCursor };
    if (Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_DIRECTORY_BYTES)
      return page;
    entries.pop();
  }
}

function reservedComponent(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".git" || lower.startsWith(".legioncode-edit-");
}
