import { BrowserWindow, session, type Session } from "electron";
import { GitHubSessionResponseSchema } from "@repo/shared-types";
import type { HostedAccountSnapshot } from "../shared/hosted-account";
import { HostedRequestScopeSchema, type HostedRequestScope } from "../shared/hosted-request";

// Release target is a closed application choice, never a renderer-supplied URL.
const BRAIN = "https://brain.legioncode.dev";
const FRONTEND = "https://legioncode.dev";
const MAX_SESSION_BYTES = 64 * 1024;

/** The Web cookie-session owner authenticates this isolated, persistent jar. */
export class DesktopHostedAccount {
  private readonly session: Session;
  private generation = 0;
  private snapshot: HostedAccountSnapshot = { target: "production", state: "signed_out", generation: 0 };
  private connection: Promise<HostedAccountSnapshot> | null = null;
  private disconnection: Promise<HostedAccountSnapshot> | null = null;
  private window: BrowserWindow | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;

  constructor() {
    this.session = session.fromPartition("persist:legioncode-hosted-production-v1");
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on("will-download", (event) => event.preventDefault());
  }

  private publish(state: HostedAccountSnapshot["state"], account?: HostedAccountSnapshot["account"]): HostedAccountSnapshot {
    this.snapshot = { target: "production", state, generation: this.generation, ...(account ? { account } : {}) };
    return this.snapshot;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  /** Main-only session loan. Logout/quit fence new loans and drain the original operation. */
  run<T>(scope: HostedRequestScope, operation: (session: Session) => Promise<T>): Promise<T> {
    const captured = Object.freeze(HostedRequestScopeSchema.parse(scope));
    const assertCurrent = () => {
      if (this.closing || this.disconnection || this.snapshot.state !== "signed_in" ||
          captured.generation !== this.generation || captured.accountId !== this.snapshot.account?.id) {
        throw new Error("Hosted account changed");
      }
    };
    assertCurrent();
    // Register before invoking a collaborator which may start a real request.
    return this.track(Promise.resolve().then(async () => {
      assertCurrent();
      const result = await operation(this.session);
      assertCurrent();
      return result;
    }));
  }

  private async readSession(generation: number): Promise<HostedAccountSnapshot> {
    return this.track((async () => {
      const response = await this.session.fetch(`${BRAIN}/auth/session`, {
        credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Hosted account is unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Hosted account response is unavailable");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_SESSION_BYTES) throw new Error("Hosted account response is too large");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const parsed = GitHubSessionResponseSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      if (this.closing || generation !== this.generation) throw new Error("Hosted account changed");
      return parsed.authenticated
        ? this.publish("signed_in", { id: parsed.user.id, login: parsed.user.login })
        : this.publish("signed_out");
    })());
  }

  async status(): Promise<HostedAccountSnapshot> {
    if (this.closing) throw new Error("Desktop is closing");
    if (this.disconnection) return this.disconnection;
    if (this.connection) return this.connection;
    if (this.snapshot.state === "sign_out_failed") return this.snapshot;
    const generation = this.generation;
    try { return await this.readSession(generation); }
    catch {
      if (generation !== this.generation || this.closing) return this.snapshot;
      return this.publish("unavailable");
    }
  }

  connect(parent: BrowserWindow): Promise<HostedAccountSnapshot> {
    if (this.closing) return Promise.reject(new Error("Desktop is closing"));
    if (this.disconnection) return Promise.reject(new Error("Hosted sign-out is pending"));
    if (this.snapshot.state === "sign_out_failed") return Promise.reject(new Error("Retry hosted sign-out first"));
    if (this.connection) return this.connection;
    const generation = ++this.generation;
    this.publish("connecting");
    const operation = this.authorize(parent, generation);
    this.connection = operation;
    void operation.finally(() => { if (this.connection === operation) this.connection = null; }).catch(() => undefined);
    return operation;
  }

  private async authorize(parent: BrowserWindow, generation: number): Promise<HostedAccountSnapshot> {
    try {
      const existing = await this.readSession(generation);
      if (existing.state === "signed_in") return existing;
      this.publish("connecting");
      await new Promise<void>((resolve, reject) => {
        const window = new BrowserWindow({
          parent, width: 640, height: 760, show: true, title: "Sign in to LegionCode",
          webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
        });
        this.window = window;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.window === window) this.window = null;
          if (!window.isDestroyed()) window.close();
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error("Hosted sign-in expired")), 10 * 60_000);
        const navigate = (event: Electron.Event, raw: string) => {
          let url: URL;
          try { url = new URL(raw); } catch { event.preventDefault(); return; }
          if (url.protocol !== "https:" || url.username || url.password) { event.preventDefault(); return; }
          if (url.origin === FRONTEND && ["/", "/agents", "/agents/"].includes(url.pathname)) {
            event.preventDefault();
            finish();
            return;
          }
          if (![BRAIN, "https://github.com"].includes(url.origin)) event.preventDefault();
        };
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", navigate);
        window.webContents.on("will-redirect", navigate);
        window.on("closed", () => finish(new Error("Hosted sign-in was cancelled")));
        void window.loadURL(`${BRAIN}/auth/github/login`).catch(() => finish(new Error("Hosted sign-in could not open")));
      });
      // A redirect is not proof of authentication. Read the same server-owned session.
      return await this.readSession(generation);
    } catch {
      if (generation !== this.generation || this.closing) return this.snapshot;
      return this.publish("signed_out");
    }
  }

  disconnect(): Promise<HostedAccountSnapshot> {
    if (this.closing) return Promise.reject(new Error("Desktop is closing"));
    if (this.disconnection) return this.disconnection;
    const operation = this.revoke();
    this.disconnection = operation;
    void operation.finally(() => { if (this.disconnection === operation) this.disconnection = null; }).catch(() => undefined);
    return operation;
  }

  private async revoke(): Promise<HostedAccountSnapshot> {
    const generation = ++this.generation;
    const account = this.snapshot.account;
    this.publish("unavailable");
    this.window?.close();
    await this.connection;
    await Promise.allSettled([...this.pending]);
    // Revoke before erasing the jar. Failed revocation remains visible and retryable.
    try {
      const response = await this.session.fetch(`${BRAIN}/auth/logout`, {
        method: "POST", credentials: "include", redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Hosted sign-out failed");
      await this.session.clearStorageData();
      await this.session.cookies.flushStore();
      if (this.closing || generation !== this.generation) return this.snapshot;
      return this.publish("signed_out");
    } catch {
      if (this.closing || generation !== this.generation) return this.snapshot;
      return this.publish("sign_out_failed", account);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    ++this.generation;
    this.window?.close();
    await this.connection;
    await this.disconnection;
    await Promise.allSettled([...this.pending]);
    await this.session.cookies.flushStore();
  }
}
