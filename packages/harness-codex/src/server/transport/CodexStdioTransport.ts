import type { Readable, Writable } from "node:stream";
import type { RequestId } from "../protocol/generated/RequestId.js";

export class CodexTransportError extends Error {
  constructor(
    readonly reason:
      | "closed"
      | "invalid_frame"
      | "overflow"
      | "timeout"
      | "io"
      | "remote_error",
    /** Once written, a lost response cannot establish whether an operation ran. */
    readonly outcome: "unknown" | "rejected" = "unknown",
    readonly remoteCode?: number,
  ) {
    // Never include upstream errors, frames, prompts, paths or credentials.
    super(`Codex transport ${reason}`);
    this.name = "CodexTransportError";
  }
}

export interface CodexServerRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: unknown;
  /** Single-use capability for this exact transport. Never reconnects or retries. */
  reply(result: unknown): void;
  reject(code: number): void;
}

export interface CodexTransportOptions {
  readonly input: Writable;
  readonly output: Readable;
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMs?: number;
  /** Handlers synchronously deliver to the host's bounded observation/request ingress. */
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onRequest: (request: CodexServerRequest) => void;
  readonly onClose: (error: CodexTransportError) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: CodexTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Newline-delimited private stdio RPC. Owns no subprocess, credentials or lifecycle. */
export class CodexStdioTransport {
  private readonly maxFrameBytes: number;
  private readonly maxPendingRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly replies = new Set<string>();
  private frameBuffer: Buffer;
  private frameBytes = 0;
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: CodexTransportOptions) {
    this.maxFrameBytes = positiveLimit(
      options.maxFrameBytes ?? 4 * 1024 * 1024,
    );
    this.frameBuffer = Buffer.alloc(this.maxFrameBytes);
    this.maxPendingRequests = positiveLimit(options.maxPendingRequests ?? 64);
    this.requestTimeoutMs = positiveLimit(options.requestTimeoutMs ?? 30_000);
    options.output.on("data", this.onData);
    options.output.on("end", this.onEnd);
    options.output.on("close", this.onEnd);
    options.output.on("error", this.onError);
    options.input.on("error", this.onError);
    options.input.on("close", this.onEnd);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new CodexTransportError("closed", "rejected"));
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new CodexTransportError("overflow", "rejected"));
    }
    const id = `legioncode:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new CodexTransportError("timeout")),
        this.requestTimeoutMs,
      );
      timer.unref();
      this.pending.set(idKey(id), { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(
          error instanceof CodexTransportError
            ? error
            : new CodexTransportError("io"),
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  close(): void {
    this.fail(new CodexTransportError("closed"));
  }

  private send(message: unknown): void {
    if (this.closed) throw new CodexTransportError("closed", "rejected");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(JSON.stringify(message) + "\n", "utf8");
    } catch {
      throw new CodexTransportError("invalid_frame", "rejected");
    }
    if (
      bytes.length > this.maxFrameBytes ||
      this.options.input.writableLength + bytes.length > this.maxFrameBytes
    ) {
      const error = new CodexTransportError("overflow");
      this.fail(error);
      throw error;
    }
    try {
      this.options.input.write(bytes, (error: Error | null | undefined) => {
        if (error) this.fail(new CodexTransportError("io"));
      });
    } catch {
      const error = new CodexTransportError("io");
      this.fail(error);
      throw error;
    }
  }

  private readonly onData = (chunk: unknown): void => {
    if (this.closed) return;
    if (!Buffer.isBuffer(chunk)) {
      this.fail(new CodexTransportError("invalid_frame"));
      return;
    }
    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.frameBytes + part.length > this.maxFrameBytes) {
        this.fail(new CodexTransportError("overflow"));
        return;
      }
      part.copy(this.frameBuffer, this.frameBytes);
      this.frameBytes += part.length;
      if (newline === -1) return;
      const frame = this.frameBuffer.subarray(0, this.frameBytes);
      this.frameBytes = 0;
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(frame),
        );
        this.receive(value);
      } catch {
        this.fail(new CodexTransportError("invalid_frame"));
      }
      offset = end + 1;
    }
  };

  private receive(value: unknown): void {
    if (!isRecord(value)) throw new CodexTransportError("invalid_frame");
    const hasId = Object.hasOwn(value, "id");
    const hasMethod = Object.hasOwn(value, "method");
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (hasMethod) {
      if (typeof value.method !== "string" || hasResult || hasError)
        throw new CodexTransportError("invalid_frame");
      if (!hasId) {
        this.options.onNotification(value.method, value.params);
        return;
      }
      if (!isId(value.id)) throw new CodexTransportError("invalid_frame");
      const id = value.id;
      const key = idKey(id);
      if (this.replies.has(key) || this.replies.size >= this.maxPendingRequests)
        throw new CodexTransportError("overflow");
      this.replies.add(key);
      let used = false;
      const settle = (payload: Record<string, unknown>): void => {
        if (used || this.closed || !this.replies.delete(key))
          throw new CodexTransportError("closed", "rejected");
        used = true;
        this.send({ id, ...payload });
      };
      this.options.onRequest(
        Object.freeze({
          id,
          method: value.method,
          params: value.params,
          reply: (result: unknown) => settle({ result }),
          reject: (code: number) => {
            if (!Number.isSafeInteger(code))
              throw new CodexTransportError("invalid_frame", "rejected");
            settle({ error: { code, message: "Request rejected" } });
          },
        }),
      );
      return;
    }
    if (!hasId || !isId(value.id) || hasResult === hasError)
      throw new CodexTransportError("invalid_frame");
    const entry = this.pending.get(idKey(value.id));
    if (!entry) throw new CodexTransportError("invalid_frame");
    if (
      hasError &&
      (!isRecord(value.error) ||
        !Number.isSafeInteger(value.error.code) ||
        typeof value.error.message !== "string")
    ) {
      throw new CodexTransportError("invalid_frame");
    }
    this.pending.delete(idKey(value.id));
    clearTimeout(entry.timer);
    if (hasError && isRecord(value.error)) {
      // RPC errors do not prove that provider execution never began.
      entry.reject(
        new CodexTransportError(
          "remote_error",
          "unknown",
          value.error.code as number,
        ),
      );
    } else entry.resolve(value.result);
  }

  private readonly onEnd = (): void =>
    this.fail(new CodexTransportError("closed"));
  private readonly onError = (): void =>
    this.fail(new CodexTransportError("io"));

  private fail(error: CodexTransportError): void {
    if (this.closed) return;
    this.closed = true;
    this.options.output.off("data", this.onData);
    this.options.output.off("end", this.onEnd);
    this.options.output.off("close", this.onEnd);
    this.options.input.off("close", this.onEnd);
    // Keep error handlers until the host disposes streams; a late EPIPE must be handled.
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.replies.clear();
    this.frameBuffer = Buffer.alloc(0);
    this.frameBytes = 0;
    this.options.onClose(error);
  }
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid Codex transport limit");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isId(value: unknown): value is RequestId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}
function idKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}
