import { session } from "electron";
import {
  createAppServerClient,
  type AppServerTransport,
} from "@legioncode/sdk/platform/app-server-client";
import { createAppServerHttpTransport } from "@legioncode/sdk/platform/app-server-http-transport";
import {
  AppServerRequestSchema,
  AppServerResponseSchema,
  type AppServerRequest,
} from "@legioncode/app-server/protocol";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";

// Auth composition must establish a fresh Brain session here. Never import a
// browser cookie or either local provider credentials or the loopback bearer.
export const HOSTED_SESSION_PARTITION = "legioncode-hosted";

export class HostedAppServer {
  private generation = 0;
  private transport: AppServerTransport | null = null;
  private controller: AbortController | null = null;
  private snapshot: AppServerEnvironmentSnapshot = this.unavailable(
    "Cloud sign-in is not connected in this build",
  );
  private readonly listeners = new Set<
    (snapshot: AppServerEnvironmentSnapshot) => void
  >();
  private readonly baseUrl: string | null;

  constructor(configuredUrl: string | undefined) {
    try {
      this.baseUrl = configuredUrl ? parseHostedOrigin(configuredUrl) : null;
    } catch {
      this.baseUrl = null;
      this.snapshot = this.unavailable("Cloud server configuration is invalid");
    }
  }

  getEnvironment(): AppServerEnvironmentSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: AppServerEnvironmentSnapshot) => void): void {
    this.listeners.add(listener);
  }

  watchSession(): void {
    session
      .fromPartition(HOSTED_SESSION_PARTITION)
      .cookies.on("changed", (_event, cookie) => {
        if (cookie.name !== "legioncode_session") return;
        this.disconnect(
          "Cloud session changed; reconnect to verify the account",
        );
      });
  }

  disconnect(reason = "Cloud connection closed"): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.transport = null;
    this.update(this.unavailable(reason));
  }

  async connect(version: string): Promise<void> {
    this.disconnect();
    const generation = this.generation;
    if (!this.baseUrl) {
      this.update(this.unavailable("Cloud server is not configured"));
      return;
    }
    this.update({ ...this.snapshot, status: "starting", reason: null });
    const partition = session.fromPartition(HOSTED_SESSION_PARTITION);
    const controller = new AbortController();
    this.controller = controller;
    const transport = createAppServerHttpTransport({
      baseUrl: this.baseUrl,
      credentials: "include",
      signal: controller.signal,
      // Fetch is confined to a main-owned session and configured origin. The
      // renderer cannot supply headers, destinations, cookies or credentials.
      fetchImpl: (input, init) => {
        if (generation !== this.generation) throw new Error("Cloud connection changed");
        return partition.fetch(input instanceof URL ? input.toString() : input, init);
      },
    });
    const client = createAppServerClient({
      clientId: "legioncode-desktop",
      clientVersion: version,
      transport,
    });
    try {
      const handshake = await client.initialize();
      if (handshake.environment !== "hosted")
        throw new Error("Expected hosted App Server");
      // initialize is public; an authenticated operation must succeed too.
      await client.listSessions();
      if (generation !== this.generation) return;
      this.transport = transport;
      this.update({
        kind: "hosted",
        status: "ready",
        protocolVersion: handshake.protocolVersion,
        serverVersion: handshake.server.version,
        capabilities: handshake.capabilities,
        unavailableCapabilities: handshake.unavailableCapabilities,
        reason: null,
      });
    } catch {
      if (generation !== this.generation) return;
      this.disconnect("Cloud authentication or connection is unavailable");
    }
  }

  async request(value: AppServerRequest): Promise<unknown> {
    const request = AppServerRequestSchema.parse(value);
    const transport = this.transport;
    const generation = this.generation;
    if (!transport || this.snapshot.status !== "ready")
      throw new Error("Cloud connection is unavailable");
    const response = AppServerResponseSchema.parse(
      await transport.request(request),
    );
    if (generation !== this.generation || transport !== this.transport)
      throw new Error("Cloud connection changed");
    if (!response.ok && response.error.code === "unauthorized")
      this.disconnect("Cloud sign-in expired or was revoked");
    return response;
  }

  private unavailable(reason: string): AppServerEnvironmentSnapshot {
    return {
      kind: "hosted",
      status: "offline",
      protocolVersion: null,
      serverVersion: null,
      capabilities: [],
      unavailableCapabilities: [],
      reason,
    };
  }

  private update(snapshot: AppServerEnvironmentSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function parseHostedOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Hosted App Server must be a configured HTTPS origin");
  }
  return url.origin;
}
