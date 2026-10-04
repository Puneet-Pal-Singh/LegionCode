import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import {
  AppServerEnvironmentSnapshotSchema,
  LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES,
  type AppServerEnvironmentSnapshot,
} from "@repo/platform-protocol";
import {
  AppServerRequestSchema,
  type AppServerRequest,
} from "@legioncode/app-server/protocol";
import {
  AppServerClientError,
  createAppServerClient,
  type AppServerTransport,
} from "@legioncode/sdk/platform/app-server-client";
import {
  createAppServerHttpTransport,
  type AppServerHttpTransportOptions,
} from "@legioncode/sdk/platform/app-server-http-transport";
import type {
  DesktopEnvironmentConnection,
  DesktopEnvironmentConfig,
  LocalAppServerMessage,
} from "../shared/desktop-api";

type RequestHeaders = NonNullable<AppServerHttpTransportOptions["requestHeaders"]>;

const STARTUP_TIMEOUT_MS = 5_000;
const LIVENESS_CHECK_MS = 250;
type SupervisedEnvironment = DesktopEnvironmentConfig & {
  connection: DesktopEnvironmentConnection | null;
};

export class LocalAppServerSupervisor {
  constructor(private readonly requestHeaders?: RequestHeaders) {}

  private child: UtilityProcess | null = null;
  private childPid: number | null = null;
  private credential: string | null = null;
  private storageDirectory: string | null = null;
  private transport: AppServerTransport | null = null;
  private config: SupervisedEnvironment = createSnapshot("starting");
  private readonly listeners = new Set<
    (snapshot: AppServerEnvironmentSnapshot) => void
  >();
  private stopping = false;
  private generation = 0;
  private restartPromise: Promise<void> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  getEnvironment(): DesktopEnvironmentConfig {
    const { connection: _connection, ...snapshot } = this.config;
    return snapshot;
  }

  subscribe(
    listener: (snapshot: AppServerEnvironmentSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(serverVersion: string, storageDirectory: string): Promise<void> {
    const generation = ++this.generation;
    this.stopping = false;
    this.childPid = null;
    this.transport = null;
    this.update(createSnapshot("starting"));
    const credential = randomBytes(32).toString("base64url");
    this.credential = credential;
    this.storageDirectory = storageDirectory;
    const child = utilityProcess.fork(
      fileURLToPath(new URL("./local-app-server.js", import.meta.url)),
      [],
      { serviceName: "LegionCode Local App Server" },
    );
    this.child = child;
    child.once("spawn", () => {
      if (generation === this.generation && child === this.child) {
        this.childPid = child.pid ?? null;
      }
    });
    this.livenessTimer = setInterval(
      () => this.checkChildLiveness(child),
      LIVENESS_CHECK_MS,
    );
    child.on("message", (message) => {
      void this.handleMessage(child, generation, message, serverVersion);
    });
    child.on("error", () => this.handleChildExit(child));
    child.on("exit", () => this.handleChildExit(child));
    child.postMessage({
      type: "start",
      credential,
      serverVersion,
      storageDirectory,
    });
    this.startupTimer = setTimeout(() => {
      if (child !== this.child || generation !== this.generation) return;
      this.update(createSnapshot("offline", "Local App Server did not start"));
      this.terminateChild(child);
    }, STARTUP_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.stopping = true;
    this.clearStartupTimer();
    this.clearLivenessTimer();
    const child = this.child;
    this.child = null;
    this.childPid = null;
    this.credential = null;
    this.transport = null;
    if (!child) {
      this.update(createSnapshot("stopped", "Local App Server stopped cleanly"));
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      child.once("exit", finish);
      child.once("error", finish);
      timeout = setTimeout(finish, STARTUP_TIMEOUT_MS);
      child.kill();
    });
    this.update(createSnapshot("stopped", "Local App Server stopped cleanly"));
  }

  async restart(serverVersion: string): Promise<void> {
    if (this.restartPromise) return await this.restartPromise;
    const restartPromise = this.restartAfterStop(serverVersion);
    this.restartPromise = restartPromise;
    try {
      await restartPromise;
    } finally {
      if (this.restartPromise === restartPromise) this.restartPromise = null;
    }
  }

  private async restartAfterStop(serverVersion: string): Promise<void> {
    const stopped = this.stop();
    const stoppedGeneration = this.generation;
    await stopped;
    if (this.generation !== stoppedGeneration) return;
    if (!this.storageDirectory) {
      throw new Error("Local App Server storage is not configured");
    }
    await this.start(serverVersion, this.storageDirectory);
  }

  async request(envelope: AppServerRequest): Promise<unknown> {
    const request = AppServerRequestSchema.parse(envelope);
    const transport = this.transport;
    const child = this.child;
    const generation = this.generation;
    if (!transport) throw new Error("Local App Server is not ready");
    const response = await transport.request(request);
    if (child !== this.child || generation !== this.generation) {
      throw new Error("Local App Server changed during the request");
    }
    return response;
  }

  private async handleMessage(
    child: UtilityProcess,
    generation: number,
    message: unknown,
    serverVersion: string,
  ): Promise<void> {
    if (
      child !== this.child ||
      generation !== this.generation ||
      !isReadyMessage(message)
    ) {
      if (isFatalMessage(message)) this.handleChildExit(child);
      return;
    }
    const baseUrl = message.baseUrl;
    this.clearStartupTimer();
    const credential = this.credential;
    if (!isLoopbackBaseUrl(baseUrl) || !credential) {
      this.update(createSnapshot("degraded", "Local App Server address was rejected"));
      this.terminateChild(child);
      return;
    }

    const transport = createAppServerHttpTransport({
      baseUrl,
      credential,
      requestHeaders: this.requestHeaders,
    });
    const client = createAppServerClient({
      clientId: "legioncode-desktop",
      clientVersion: serverVersion,
      transport,
    });
    try {
      const handshake = await client.initialize([
        ...LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES,
      ]);
      if (child !== this.child || generation !== this.generation) return;
      const snapshot = AppServerEnvironmentSnapshotSchema.parse({
        kind: handshake.environment,
        status: "ready",
        protocolVersion: handshake.protocolVersion,
        serverVersion: handshake.server.version,
        capabilities: handshake.capabilities,
        unavailableCapabilities: handshake.unavailableCapabilities,
        reason: null,
      });
      this.transport = transport;
      this.update({ ...snapshot, connection: { baseUrl, credential } });
    } catch (error) {
      if (child !== this.child || generation !== this.generation) return;
      const reason =
        error instanceof AppServerClientError &&
        error.serverCode === "protocol_incompatible"
          ? "Local App Server protocol is incompatible"
          : "Local App Server handshake failed";
      this.update(createSnapshot("degraded", reason));
      this.terminateChild(child);
    }
  }

  private handleChildExit(child: UtilityProcess): void {
    if (child !== this.child) return;
    this.clearStartupTimer();
    this.clearLivenessTimer();
    this.child = null;
    this.childPid = null;
    this.credential = null;
    this.transport = null;
    if (this.stopping) return;
    this.update(createSnapshot("offline", "Local App Server stopped unexpectedly"));
  }

  private terminateChild(child: UtilityProcess): void {
    this.stopping = true;
    child.kill();
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private checkChildLiveness(child: UtilityProcess): void {
    if (child !== this.child) {
      this.clearLivenessTimer();
      return;
    }
    const pid = this.childPid ?? child.pid;
    if (pid === undefined) return;
    this.childPid = pid;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        this.handleChildExit(child);
      }
    }
  }

  private clearLivenessTimer(): void {
    if (!this.livenessTimer) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  private update(next: SupervisedEnvironment): void {
    this.config = next;
    const { connection: _connection, ...snapshot } = next;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function createSnapshot(
  status: AppServerEnvironmentSnapshot["status"],
  reason: string | null = null,
): SupervisedEnvironment {
  return {
    kind: "local",
    status,
    protocolVersion: null,
    serverVersion: null,
    capabilities: [],
    unavailableCapabilities: LOCAL_APP_SERVER_UNAVAILABLE_CAPABILITIES.map(
      (capability) => ({
        capability,
        reason: "This local capability is planned for a later slice",
      }),
    ),
    reason,
    connection: null,
  };
}

function isReadyMessage(message: unknown): message is LocalAppServerMessage & {
  type: "ready";
} {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "ready" &&
    typeof (message as { baseUrl?: unknown }).baseUrl === "string"
  );
}

function isFatalMessage(message: unknown): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "fatal"
  );
}

function isLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
