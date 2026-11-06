import { readOpenCodeEvents } from "./OpenCodeEventStream.js";
import { ServerInfo } from "@opencode/protocol/groups/server";
import { Schema } from "effect";
import {
  OpenCode,
  type OpenCodeClient as NativeClient,
  type OpenCodeEvent,
} from "@opencode/client";
import {
  requireOpenCodeVersion,
  requirePrivateOpenCodeUrl,
} from "./OpenCodeInstallation.js";

/** Errors intentionally omit SDK causes: HTTP failures can contain headers and provider payloads. */
export class OpenCodeTransportError extends Error {
  constructor(
    readonly operation: string,
    readonly recoveryRequired: boolean,
  ) {
    super(
      `OpenCode ${operation} failed${recoveryRequired ? "; reconciliation is required" : ""}.`,
    );
    this.name = "OpenCodeTransportError";
  }
}

/** Native transport only. Canonical observation persistence and acknowledgements belong to the host. */
export class OpenCodeClient {
  private readonly native: NativeClient;
  private readonly events: (
    activity: () => void,
  ) => AsyncIterable<OpenCodeEvent>;
  private readonly stream = new AbortController();
  private verified = false;
  private disconnectedResolve!: (reason: "gap" | "closed") => void;
  readonly disconnected = new Promise<"gap" | "closed">((resolve) => {
    this.disconnectedResolve = resolve;
  });
  private state: "new" | "subscribing" | "ready" | "gap" | "closed" = "new";
  private lastActivity = Date.now();
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private reader: Promise<void> | undefined;

  constructor(baseUrl: string, password: string) {
    const origin = requirePrivateOpenCodeUrl(baseUrl);
    if (!/^[A-Za-z0-9_-]{43}$/.test(password))
      throw new Error("Invalid OpenCode transport credential.");
    const authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
    this.events = (activity) =>
      readOpenCodeEvents({
        origin,
        authorization,
        signal: this.stream.signal,
        activity,
      });
    this.native = OpenCode.make({
      baseUrl: origin,
      headers: {
        Authorization: authorization,
      },
      // A redirect must never forward the private transport credential to another origin.
      fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    });
  }

  async verify(expectedPid: number): Promise<void> {
    if (this.state !== "new")
      throw new OpenCodeTransportError("server.info", true);
    if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)
      throw new Error("Missing OpenCode process identity.");
    try {
      const info = await this.native.server.info({
        signal: AbortSignal.timeout(5000),
      });
      if (!Schema.is(Schema.toEncoded(ServerInfo))(info))
        throw new Error("Invalid OpenCode readiness data.");
      requireOpenCodeVersion(info.version);
      if (info.pid !== expectedPid)
        throw new Error("OpenCode process identity changed.");
      this.verified = true;
    } catch {
      throw new OpenCodeTransportError("server.info", false);
    }
  }

  /** Resolves only after server.connected; constructing an AsyncIterable does not subscribe. */
  async subscribe(
    commit: (event: OpenCodeEvent) => Promise<void>,
  ): Promise<void> {
    if (this.state !== "new" || !this.verified)
      throw new OpenCodeTransportError("subscribe", true);
    this.state = "subscribing";
    let accept!: () => void;
    let reject!: (error: OpenCodeTransportError) => void;
    const ready = new Promise<void>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    const timeout = setTimeout(() => this.fail(), 10000);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > 45000) this.fail();
    }, 1000);
    this.watchdog.unref();
    this.reader = (async () => {
      try {
        for await (const event of this.events(() => {
          this.lastActivity = Date.now();
        })) {
          if (event.type === "server.connected") {
            if (this.state !== "subscribing")
              throw new OpenCodeTransportError("stream continuity", true);
            this.state = "ready";
            clearTimeout(timeout);
            accept();
            continue;
          }
          if (this.state !== "ready") break;
          // Serial, awaited delivery; the native SSE reader bounds frames without a producer queue.
          await commit(event);
        }
      } catch {
        this.fail();
      } finally {
        clearTimeout(timeout);
        if (this.watchdog) clearInterval(this.watchdog);
        if (this.state !== "closed") this.fail();
        reject(new OpenCodeTransportError("event stream", true));
      }
    })();
    await ready;
  }

  /** Any uncertain mutation fences this transport. Callers must never retry prompt/steer/reply. */
  async mutate<T>(
    operation: string,
    action: (api: NativeClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.state !== "ready")
      throw new OpenCodeTransportError(operation, true);
    try {
      const result = await action(
        this.native,
        AbortSignal.any([this.stream.signal, AbortSignal.timeout(10000)]),
      );
      if (this.state !== "ready")
        throw new OpenCodeTransportError(operation, true);
      return result;
    } catch {
      this.fail();
      throw new OpenCodeTransportError(operation, true);
    }
  }

  /** Provider state is recovery evidence, never canonical replay. */
  async inspect<T>(
    operation: string,
    action: (api: NativeClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.state === "closed")
      throw new OpenCodeTransportError(operation, true);
    try {
      return await action(this.native, AbortSignal.timeout(10000));
    } catch {
      throw new OpenCodeTransportError(operation, this.state === "gap");
    }
  }

  invalidate(operation: string): never {
    this.fail();
    throw new OpenCodeTransportError(operation, true);
  }

  get continuity(): "new" | "subscribing" | "ready" | "gap" | "closed" {
    return this.state;
  }

  /** Closing transport is not proof that the provider process or descendants stopped. */
  async close(): Promise<void> {
    this.state = "closed";
    this.disconnectedResolve("closed");
    this.stream.abort();
    if (this.watchdog) clearInterval(this.watchdog);
    await this.reader;
  }

  private fail(): void {
    if (this.state !== "closed") {
      this.state = "gap";
      this.disconnectedResolve("gap");
    }
    this.stream.abort();
  }
}
