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
  assertLocalAppServerRequestBudget,
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
import { type ProviderId } from "@repo/shared-types";
import {
  RuntimeCredentialRequestSchema,
  RuntimeCredentialResponseSchema,
  RuntimeCredentialCancelSchema,
  sameRuntimeCredentialReference,
  type RuntimeCredentialReference,
  type RuntimeCredentialCancel,
  type RuntimeCredentialRequest,
  type RuntimeCredentialLease,
} from "./runtime-credentials";
import { LocalAppServerClosure } from "./local-app-server-closure";
import { NativeHostBrokerConfigurationSchema } from "../shared/native-host-broker-config";
import type {
  DesktopEnvironmentConnection,
  DesktopEnvironmentConfig,
  LocalAppServerMessage,
  LocalAppServerHostConfig,
} from "../shared/desktop-api";

type RequestHeaders = NonNullable<
  AppServerHttpTransportOptions["requestHeaders"]
>;
type CredentialRequestOwner = {
  readonly request: RuntimeCredentialRequest;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly controller: AbortController;
};
type CredentialLookup = {
  /** Retain the actual collaborator promise, even after its delivery was cancelled. */
  original: Promise<RuntimeCredentialLease | RuntimeCredentialReference | null> | null;
  readonly settled: Promise<void>;
};
export interface RuntimeCredentialReferencePort {
  captureRuntimeCredentialReference(providerId: ProviderId, signal: AbortSignal): Promise<RuntimeCredentialReference | null>;
  acquireRuntimeCredential(reference: RuntimeCredentialReference, signal: AbortSignal): Promise<RuntimeCredentialLease | null>;
}

const STARTUP_TIMEOUT_MS = 5_000;
const LIVENESS_CHECK_MS = 250;
type SupervisedEnvironment = DesktopEnvironmentConfig & {
  connection: DesktopEnvironmentConnection | null;
};

export class LocalAppServerSupervisor {
  constructor(
    private readonly requestHeaders?: RequestHeaders,
    private readonly resolveRuntimeCredential?: (
      providerId: ProviderId,
      signal?: AbortSignal,
    ) => Promise<RuntimeCredentialLease | null>,
    private readonly runtimeCredentialReferences?: RuntimeCredentialReferencePort,
  ) {}

  // Timed-out deliveries still occupy a slot until their resolver settles.
  private readonly credentialLookups = new Set<CredentialLookup>();
  private readonly credentialRequests = new Map<string, CredentialRequestOwner>();

  private child: UtilityProcess | null = null;
  private handshakeChild: UtilityProcess | null = null;
  private closure: LocalAppServerClosure | null = null;
  private childPid: number | null = null;
  private credential: string | null = null;
  private storageDirectory: string | null = null;
  private hostConfig: LocalAppServerHostConfig | undefined;
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

  async start(
    serverVersion: string,
    storageDirectory: string,
    hostConfig?: LocalAppServerHostConfig,
  ): Promise<void> {
    if (this.child || this.closure || this.credentialLookups.size > 0) {
      throw new Error("The previous local runtime closure is unconfirmed");
    }
    const capturedHostConfig = hostConfig ? Object.freeze({
      protectedHostRoots: Object.freeze([...hostConfig.protectedHostRoots]),
      nativeWriterFenceDirectory: hostConfig.nativeWriterFenceDirectory,
      nativeFilesystemHelperPath: hostConfig.nativeFilesystemHelperPath,
      nativeProcessHelperPath: hostConfig.nativeProcessHelperPath,
      ...(hostConfig.nativeHostBroker === undefined ? {} : {
        nativeHostBroker: NativeHostBrokerConfigurationSchema.parse(hostConfig.nativeHostBroker),
      }),
    }) : undefined;
    const generation = ++this.generation;
    this.stopping = false;
    this.handshakeChild = null;
    this.childPid = null;
    this.transport = null;
    this.update(createSnapshot("starting"));
    const credential = randomBytes(32).toString("base64url");
    this.credential = credential;
    this.storageDirectory = storageDirectory;
    this.hostConfig = capturedHostConfig;
    const child = utilityProcess.fork(
      fileURLToPath(new URL("./local-app-server.js", import.meta.url)),
      [],
      { serviceName: "LegionCode Local App Server" },
    );
    this.child = child;
    this.closure = new LocalAppServerClosure(child);
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
      const cancel = RuntimeCredentialCancelSchema.safeParse(message);
      if (cancel.success) {
        this.cancelCredentialRequest(child, generation, cancel.data);
        return;
      }
      const request = RuntimeCredentialRequestSchema.safeParse(message);
      if (request.success) {
        void this.handleCredentialRequest(child, generation, request.data);
        return;
      }
      void this.handleMessage(child, generation, message, serverVersion);
    });
    child.on("error", () => this.handleChildExit(child));
    child.on("exit", () => this.handleChildExit(child));
    try {
      child.postMessage({
        type: "start",
        credential,
        serverVersion,
        storageDirectory,
        protectedHostRoots: this.hostConfig?.protectedHostRoots,
        nativeWriterFenceDirectory: this.hostConfig?.nativeWriterFenceDirectory,
        nativeFilesystemHelperPath: this.hostConfig?.nativeFilesystemHelperPath,
        nativeProcessHelperPath: this.hostConfig?.nativeProcessHelperPath,
        ...(this.hostConfig?.nativeHostBroker === undefined ? {} : {
          nativeHostBroker: this.hostConfig.nativeHostBroker,
        }),
      });
    } catch {
      this.requestChildShutdown(child);
      throw new Error("Local App Server startup request could not be delivered");
    }
    this.startupTimer = setTimeout(() => {
      if (child !== this.child || generation !== this.generation) return;
      this.update(createSnapshot("offline", "Local App Server did not start"));
      this.requestChildShutdown(child);
    }, STARTUP_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const stoppedGeneration = this.generation;
    this.stopping = true;
    this.clearCredentialRequests();
    this.clearStartupTimer();
    this.clearLivenessTimer();
    this.credential = null;
    this.transport = null;
    const closure = this.closure;
    if (!closure) {
      if (this.child) throw new Error("Local runtime closure ownership is unavailable");
      await this.drainCredentialLookups();
      if (this.generation === stoppedGeneration && !this.child && !this.closure) {
        this.update(createSnapshot("stopped", "Local App Server stopped cleanly"));
      }
      return;
    }
    this.update(createSnapshot("degraded", "Local App Server shutdown is pending"));
    try {
      await Promise.all([closure.requestShutdown(), this.drainCredentialLookups()]);
      if (this.generation === stoppedGeneration && !this.child && !this.closure && this.credentialLookups.size === 0) {
        this.update(createSnapshot("stopped", "Local App Server stopped cleanly"));
      }
    } catch {
      if (this.closure === closure || (this.stopping && this.credentialLookups.size > 0)) {
        this.update(createSnapshot("degraded", "Local runtime closure is unconfirmed; its ownership is retained"));
      }
      throw new Error("Local runtime closure is unconfirmed");
    }
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
    await this.start(serverVersion, this.storageDirectory, this.hostConfig);
  }

  async request(envelope: AppServerRequest): Promise<unknown> {
    const request = AppServerRequestSchema.parse(envelope);
    assertLocalAppServerRequestBudget(request);
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

  private async handleCredentialRequest(
    child: UtilityProcess,
    generation: number,
    request: RuntimeCredentialRequest,
  ): Promise<void> {
    if (child !== this.child || generation !== this.generation || this.stopping) return;
    if (request.purpose === "acquire" && request.reference.providerId !== request.providerId) return;
    if (this.credentialRequests.has(request.requestId)) return;
    if (this.credentialLookups.size >= 32) {
      this.replyCredential(child, generation, request, null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (this.credentialRequests.get(request.requestId) !== owner) return;
      this.credentialRequests.delete(request.requestId);
      controller.abort();
      this.replyCredential(child, generation, request, null);
    }, 10_000);
    const owner: CredentialRequestOwner = { request, timer, controller };
    this.credentialRequests.set(request.requestId, owner);
    let resolveSettled!: () => void;
    const lookup: CredentialLookup = {
      original: null,
      settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
    };
    // Reserve custody BEFORE invoking the collaborator: a reentrant stop must see this obligation.
    this.credentialLookups.add(lookup);
    let result: RuntimeCredentialLease | RuntimeCredentialReference | null = null;
    try {
      if (child !== this.child || generation !== this.generation || this.stopping || controller.signal.aborted) return;
      lookup.original = request.purpose === "capture"
        ? this.runtimeCredentialReferences?.captureRuntimeCredentialReference(request.providerId, controller.signal) ?? Promise.resolve(null)
        : request.purpose === "acquire"
          ? this.runtimeCredentialReferences?.acquireRuntimeCredential(request.reference, controller.signal) ?? Promise.resolve(null)
          : this.resolveRuntimeCredential?.(request.providerId, controller.signal) ?? Promise.resolve(null);
      // Cancellation/timeout only suppresses delivery. The original promise still owns its drain slot.
      result = await lookup.original;
    } catch {
      // Vault errors and their data never cross the private response boundary.
    } finally {
      this.credentialLookups.delete(lookup);
      resolveSettled();
    }
    if (this.credentialRequests.get(request.requestId) !== owner) return;
    clearTimeout(timer);
    this.credentialRequests.delete(request.requestId);
    if (controller.signal.aborted) return;
    this.replyCredential(child, generation, request, result);
  }

  private replyCredential(
    child: UtilityProcess,
    generation: number,
    request: RuntimeCredentialRequest,
    result: RuntimeCredentialLease | RuntimeCredentialReference | null,
  ): void {
    if (child !== this.child || generation !== this.generation || this.stopping) return;
    const base = { type: "runtime-credential-response" as const, requestId: request.requestId, providerId: request.providerId };
    try {
      if (request.purpose === "capture") {
        const reference = result && "connectionId" in result && result.providerId === request.providerId ? result : null;
        const response = RuntimeCredentialResponseSchema.parse({ ...base, purpose: "capture", reference });
        if (child === this.child && generation === this.generation && !this.stopping) child.postMessage(response);
        return;
      }
      const lease = result && "canDeliver" in result ? result : null;
      const exact = request.purpose !== "acquire" || Boolean(lease?.reference &&
        sameRuntimeCredentialReference(request.reference, lease.reference));
      const credential = exact && lease?.canDeliver() &&
        (!lease.credential?.connectionConfig || lease.credential.connectionConfig.providerId === request.providerId)
        ? lease.credential : null;
      const response = RuntimeCredentialResponseSchema.parse(request.purpose === "acquire"
        ? { ...base, purpose: "acquire", reference: request.reference, credential }
        : { ...base, purpose: "discovery", credential });
      if (child !== this.child || generation !== this.generation || this.stopping) return;
      // Recheck the live delivery lease immediately before the only secret-bearing serialization.
      if ("credential" in response && response.credential !== null && !lease?.canDeliver()) response.credential = null;
      child.postMessage(response);
    } catch {
      // Process loss or invalid private data cannot leak secret-bearing errors or prove settlement.
    }
  }

  private cancelCredentialRequest(child: UtilityProcess, generation: number, cancel: RuntimeCredentialCancel): void {
    if (child !== this.child || generation !== this.generation || this.stopping) return;
    const owner = this.credentialRequests.get(cancel.requestId);
    if (!owner || owner.request.purpose !== cancel.purpose || owner.request.providerId !== cancel.providerId) return;
    if (owner.request.purpose === "acquire" && (!cancel.reference || !sameRuntimeCredentialReference(owner.request.reference, cancel.reference))) return;
    if (owner.request.purpose !== "acquire" && cancel.reference !== undefined) return;
    clearTimeout(owner.timer);
    this.credentialRequests.delete(cancel.requestId);
    owner.controller.abort();
  }

  private clearCredentialRequests(): void {
    for (const owner of this.credentialRequests.values()) {
      clearTimeout(owner.timer);
      owner.controller.abort();
    }
    this.credentialRequests.clear();
  }

  private async drainCredentialLookups(): Promise<void> {
    const pending = [...this.credentialLookups].map((lookup) => lookup.settled);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Protected provider lookup closure is unconfirmed")), 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleMessage(
    child: UtilityProcess,
    generation: number,
    message: unknown,
    serverVersion: string,
  ): Promise<void> {
    if (child !== this.child) return;
    // Closure belongs to the actual child, independently of request generations.
    if (isClosedMessage(message)) {
      this.closure?.acknowledgeClosed();
      this.clearCredentialRequests();
      this.clearStartupTimer();
      this.clearLivenessTimer();
      this.child = null;
      this.closure = null;
      this.childPid = null;
      this.credential = null;
      this.transport = null;
      if (!this.stopping) this.generation += 1;
      this.stopping = true;
      this.update(this.credentialLookups.size === 0
        ? createSnapshot("stopped", "Local App Server stopped cleanly")
        : createSnapshot("degraded", "Protected provider requests are still draining"));
      return;
    }
    if (isFatalMessage(message)) {
      if (message.reason === "runtime-shutdown-failed") {
        this.handleChildExit(child);
      } else {
        this.requestChildShutdown(child);
      }
      return;
    }
    if (
      generation !== this.generation ||
      this.stopping ||
      !isReadyMessage(message)
    ) {
      return;
    }
    if (this.handshakeChild === child) return;
    this.handshakeChild = child;
    const baseUrl = message.baseUrl;
    const credential = this.credential;
    if (!isLoopbackBaseUrl(baseUrl) || !credential) {
      this.update(
        createSnapshot("degraded", "Local App Server address was rejected"),
      );
      this.requestChildShutdown(child);
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
      if (child !== this.child || generation !== this.generation || !this.startupTimer) return;
      const snapshot = AppServerEnvironmentSnapshotSchema.parse({
        kind: handshake.environment,
        status: "ready",
        protocolVersion: handshake.protocolVersion,
        serverVersion: handshake.server.version,
        capabilities: handshake.capabilities,
        unavailableCapabilities: handshake.unavailableCapabilities,
        reason: null,
      });
      this.clearStartupTimer();
      this.transport = transport;
      this.update({ ...snapshot, connection: { baseUrl, credential } });
    } catch (error) {
      if (child !== this.child || generation !== this.generation || !this.startupTimer) return;
      const reason =
        error instanceof AppServerClientError &&
        error.serverCode === "protocol_incompatible"
          ? "Local App Server protocol is incompatible"
          : "Local App Server handshake failed";
      this.clearStartupTimer();
      this.update(createSnapshot("degraded", reason));
      this.requestChildShutdown(child);
    }
  }

  private handleChildExit(child: UtilityProcess): void {
    if (child !== this.child) return;
    this.generation += 1;
    this.stopping = true;
    this.clearCredentialRequests();
    this.clearStartupTimer();
    this.clearLivenessTimer();
    this.credential = null;
    this.transport = null;
    this.closure?.markUnknown("Local runtime physical closure is unconfirmed");
    this.update(
      createSnapshot("offline", "Local runtime closure is unconfirmed; its ownership is retained"),
    );
  }

  private requestChildShutdown(child: UtilityProcess): void {
    if (child !== this.child) return;
    // stop reports failure while retaining the same child and closure obligation.
    void this.stop().catch(() => undefined);
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
    for (const listener of this.listeners) {
      try { listener(snapshot); }
      catch { /* Notification observers cannot interrupt retained ownership. */ }
    }
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

function isFatalMessage(message: unknown): message is LocalAppServerMessage & { type: "fatal" } {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "fatal"
  );
}

function isClosedMessage(message: unknown): message is LocalAppServerMessage & { type: "closed" } {
  return !!message && typeof message === "object" &&
    (message as { type?: unknown }).type === "closed" && Object.keys(message).length === 1;
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
