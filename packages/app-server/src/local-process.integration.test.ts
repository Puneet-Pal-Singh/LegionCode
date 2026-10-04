import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_SERVER_PROTOCOL_VERSION } from "./protocol.js";
import { createLocalAppServer } from "./local-process.js";
import { handleAppServerHttpRequest } from "./server.js";
import { LocalThreadService } from "./local-threads.js";
import { LocalWorkspaceService } from "./local-workspace.js";
import { LocalPersistence } from "@repo/event-store/local";
import { LocalPersistenceError } from "@repo/event-store/errors";
import {
  EVENT_SCHEMA_VERSION,
  LocalWorkspaceGrantSchema,
  PlatformEventSchema,
  ThreadSchema,
} from "@repo/platform-protocol";
import { getBuiltinRegistry, builtinProviderRegistry } from "@repo/provider-core";

const credential = "local-test-credential";
const liveServers: ReturnType<typeof createLocalAppServer>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(liveServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local App Server HTTP integration", () => {
  it("serves workspace and thread commands through one envelope and replays after restart", async () => {
    const { storageDirectory, workspacePath } = await fixture();
    const firstServer = await start(storageDirectory);
    const baseUrl = serverUrl(firstServer);
    const initialize = await send(baseUrl, "initialize", {
      client: { id: "test-client", version: "0.1.0" },
      requestedCapabilities: ["workspace-selection-v1"],
    });
    expect(initialize).toMatchObject({ ok: true, method: "initialize", result: { environment: "local" } });

    const grant = await send(baseUrl, "workspace/grant", { path: workspacePath });
    expect(grant).toMatchObject({ ok: true, method: "workspace/grant", result: { grant: { readiness: "ready" } } });
    const created = await send(baseUrl, "thread/create", { title: "First thread" });
    const threadId = (created as { result: { thread: { id: string } } }).result.thread.id;
    expect(created).toMatchObject({ ok: true, method: "thread/create", result: { thread: { title: "First thread" } } });

    const renamed = await send(baseUrl, "thread/rename", { threadId, title: "Renamed" });
    await send(baseUrl, "thread/archive", { threadId });
    await send(baseUrl, "thread/unarchive", { threadId });
    expect((renamed as { result: { thread: unknown } }).result.thread).toMatchObject({ title: "Renamed" });
    await expect(send(baseUrl, "thread/get", { threadId })).resolves.toMatchObject({
      ok: true,
      result: { thread: { title: "Renamed", status: "active" } },
    });

    await close(firstServer);
    const restarted = await start(storageDirectory);
    const restartedUrl = serverUrl(restarted);
    await expect(send(restartedUrl, "thread/list", {})).resolves.toMatchObject({
      ok: true,
      result: { threads: [{ id: threadId, title: "Renamed", status: "active" }] },
    });
    await send(restartedUrl, "workspace/revoke", {});
    await expect(send(restartedUrl, "workspace/current", {})).resolves.toMatchObject({
      ok: true,
      result: { grant: null },
    });
    expect(restarted.listening).toBe(true);
  });

  it("migrates legacy Thread and workspace records before serving replay", async () => {
    const { storageDirectory, workspacePath } = await fixture();
    const timestamp = "2026-09-20T00:00:00.000Z";
    const grant = LocalWorkspaceGrantSchema.parse({
      workspaceId: "wrk_localworkspace",
      displayName: "repository",
      repositoryIdentity: "github.com/example/repository",
      branch: "main",
      readiness: "ready",
      capabilities: ["filesystem", "git"],
      reason: null,
      grantedAt: timestamp,
    });
    const thread = ThreadSchema.parse({
      id: "thr_legacythread",
      userId: "usr_localdesktop",
      workspaceId: grant.workspaceId,
      title: "Legacy local thread",
      titleSource: "user",
      titleVersion: 1,
      titleStatus: "ready",
      lastTerminalTurnId: null,
      status: "active",
      pinnedAt: null,
      archivedAt: null,
      activeRunId: null,
      activeLeafItemId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastEventSequence: 1,
    });
    const legacyEvent = PlatformEventSchema.parse({
      eventId: "evt_legacythread1",
      cursor: "cursor_legacythread1",
      sequence: 1,
      createdAt: timestamp,
      threadId: thread.id,
      workspaceId: grant.workspaceId,
      runId: null,
      scopeType: "thread",
      scopeId: thread.id,
      type: "thread.created",
      payload: { thread },
      idempotencyKey: `thread-created:${thread.id}`,
      producer: { kind: "control_plane", id: "local-app-server" },
      schemaVersion: EVENT_SCHEMA_VERSION,
    });
    await writeFile(
      join(storageDirectory, "thread-events.json"),
      JSON.stringify({ version: 1, events: [legacyEvent] }),
    );
    await writeFile(
      join(storageDirectory, "workspace-grant.json"),
      JSON.stringify({ version: 1, path: await realpath(workspacePath), grant }),
    );

    const server = await start(storageDirectory);
    const baseUrl = serverUrl(server);
    await expect(send(baseUrl, "workspace/current", {})).resolves.toMatchObject({
      ok: true,
      result: { grant: { workspaceId: grant.workspaceId, readiness: "ready", reason: null } },
    });
    await expect(send(baseUrl, "thread/list", {})).resolves.toMatchObject({
      ok: true,
      result: { threads: [{ id: thread.id, title: thread.title }] },
    });
    await close(server);
    const reopened = await start(storageDirectory);
    await expect(send(serverUrl(reopened), "thread/get", { threadId: thread.id })).resolves.toMatchObject({
      ok: true,
      result: { thread: { id: thread.id, title: thread.title } },
    });
  });

  it("refuses corrupt legacy persistence before creating a listening server", async () => {
    const { storageDirectory } = await fixture();
    const corruptPath = join(storageDirectory, "thread-events.json");
    const corruptData = "not-json-and-must-be-preserved";
    await writeFile(corruptPath, corruptData);

    let startupError: unknown;
    try {
      createLocalAppServer({ credential, serverVersion: "test", storageDirectory });
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toBeInstanceOf(LocalPersistenceError);
    expect((startupError as Error).message).not.toContain(storageDirectory);
    expect(await readFile(corruptPath, "utf8")).toBe(corruptData);
  });

  it("reports a closed local database as server unavailable, not invalid input", async () => {
    const { storageDirectory } = await fixture();
    const persistence = new LocalPersistence({ storageDirectory });
    const workspaceService = new LocalWorkspaceService({
      workspaceGrants: persistence.workspaceGrants,
    });
    const threadService = new LocalThreadService({
      events: persistence.events,
      getWorkspace: () => workspaceService.getCurrent(),
    });
    persistence.close();

    const result = await handleAppServerHttpRequest(
      {
        method: "POST",
        path: "/app-server/request",
        host: "127.0.0.1:1234",
        origin: "http://127.0.0.1:1234",
        authorization: `Bearer ${credential}`,
        contentType: "application/json",
        rawBody: JSON.stringify({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: "workspace/current",
          params: {},
        }),
      },
      {
        environment: "local",
        serverId: "test",
        serverVersion: "test",
        credential,
        workspaceService,
        threadService,
      },
    );

    expect(result.statusCode).toBe(503);
    expect(result.payload).toMatchObject({
      method: "workspace/current",
      ok: false,
      error: { code: "server_unavailable", message: "App Server storage is unavailable" },
    });
    expect(JSON.stringify(result.payload)).not.toContain(storageDirectory);
  });

  it("rejects unauthorized, non-loopback, oversized, malformed, and unknown requests", async () => {
    const { storageDirectory } = await fixture();
    const baseUrl = serverUrl(await start(storageDirectory));

    await expect(send(baseUrl, "initialize", {
      client: { id: "test-client", version: "0.1.0" },
      requestedCapabilities: [],
    }, "wrong")).resolves.toMatchObject({ code: "unauthorized" });
    await expect(send(baseUrl, "initialize", {
      client: { id: "test-client", version: "0.1.0" },
      requestedCapabilities: [],
    }, credential, "https://attacker.example")).resolves.toMatchObject({ code: "unauthorized" });

    const oversized = await fetch(`${baseUrl}/app-server/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: "x".repeat(33_000),
    });
    expect(oversized.status).toBe(413);

    const unknown = await rawRequest(baseUrl, {
      method: "POST",
      host: "attacker.example",
      authorization: `Bearer ${credential}`,
      body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "unknown", params: {} }),
    });
    expect(unknown.status).toBe(403);

    const malformed = await fetch(`${baseUrl}/app-server/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", params: { extra: true } }),
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ ok: false, method: "thread/list", error: { code: "invalid_request" } });

    const unknownMethod = await fetch(`${baseUrl}/app-server/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "unknown", params: {} }),
    });
    expect(unknownMethod.status).toBe(400);
    await expect(unknownMethod.json()).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("rejects an unresolved workspace selection token at the local server boundary", async () => {
    const { storageDirectory } = await fixture();
    const baseUrl = serverUrl(await start(storageDirectory));
    await expect(send(baseUrl, "workspace/grant", { selectionToken: "opaque-picker-token" })).resolves.toMatchObject({
      ok: false,
      method: "workspace/grant",
      error: { code: "invalid_request" },
    });
  });

  it("serves registry-backed providers and persists only a verified provider/model selection", async () => {
    const { storageDirectory } = await fixture();
    const server = await start(storageDirectory);
    const baseUrl = serverUrl(server);
    const catalog = await send(baseUrl, "provider/catalog", {});
    const expectedProviders = getBuiltinRegistry().providers.filter((provider) =>
      provider.launchStage === "supported" && provider.authModes.includes("api_key"),
    );
    expect(catalog).toMatchObject({ ok: true, result: { providers: expectedProviders } });

    const provider = expectedProviders.find((entry) => builtinProviderRegistry.listModels(entry.providerId).length > 0);
    if (!provider) throw new Error("Test registry has no supported API-key model");
    const models = await send(baseUrl, "provider/models", { providerId: provider.providerId });
    expect(models).toMatchObject({
      ok: true,
      result: {
        providerId: provider.providerId,
        models: [{ providerId: provider.providerId }],
        metadata: { source: "registry", status: "available" },
      },
    });
    const modelId = builtinProviderRegistry.listModels(provider.providerId)[0]!.modelId;

    await expect(send(baseUrl, "provider/select", { providerId: provider.providerId, modelId }))
      .resolves.toMatchObject({ ok: false, method: "provider/select" });
    await expect(send(baseUrl, "provider/current", {})).resolves.toMatchObject({ ok: true, result: { selection: null } });
    await expect(send(baseUrl, "provider/select", { providerId: provider.providerId, modelId }, credential, undefined, "{bad"))
      .resolves.toMatchObject({ code: "invalid_request" });
    await expect(send(baseUrl, "provider/select", { providerId: provider.providerId, modelId }, credential, undefined,
      JSON.stringify({ providerId: provider.providerId === "openai" ? "groq" : "openai", status: "present" })))
      .resolves.toMatchObject({ ok: false, method: "provider/select" });
    await expect(send(baseUrl, "provider/select", { providerId: provider.providerId, modelId: "unregistered-model" }, credential, undefined,
      JSON.stringify({ providerId: provider.providerId, status: "present" })))
      .resolves.toMatchObject({ ok: false, method: "provider/select" });

    const secretSentinel = "provider-secret-never-transmitted";
    const secretConfigurationResponse = await send(baseUrl, "provider/select", {
      providerId: provider.providerId,
      modelId,
    }, credential, undefined, JSON.stringify({
      providerId: provider.providerId,
      status: "present",
      secret: secretSentinel,
    }));
    expect(secretConfigurationResponse).toMatchObject({ code: "invalid_request" });
    expect(JSON.stringify(secretConfigurationResponse)).not.toContain(secretSentinel);
    const selected = await send(baseUrl, "provider/select", { providerId: provider.providerId, modelId }, credential, undefined,
      JSON.stringify({ providerId: provider.providerId, status: "present" }));
    expect(selected).toMatchObject({ ok: true, result: { selection: { providerId: provider.providerId, modelId } } });
    expect(JSON.stringify(selected)).not.toContain(secretSentinel);
    await close(server);
    const restarted = await start(storageDirectory);
    await expect(send(serverUrl(restarted), "provider/current", {})).resolves.toMatchObject({
      ok: true,
      result: { selection: { providerId: provider.providerId, modelId } },
    });
    await expect(send(serverUrl(restarted), "provider/clear", {})).resolves.toMatchObject({
      ok: true,
      result: { selection: null },
    });
    await expect(send(serverUrl(restarted), "provider/current", {})).resolves.toMatchObject({
      ok: true,
      result: { selection: null },
    });
    const persistedBytes = await readFile(join(storageDirectory, "local-events.sqlite"));
    expect(persistedBytes.toString("utf8")).not.toContain(secretSentinel);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legioncode-app-server-http-"));
  temporaryDirectories.push(root);
  const storageDirectory = join(root, "storage");
  await mkdir(storageDirectory, { recursive: true });
  const workspacePath = join(root, "repository");
  await mkdir(workspacePath);
  execFileSync("git", ["init", workspacePath], { stdio: "ignore" });
  execFileSync("git", ["-C", workspacePath, "remote", "add", "origin", "https://github.com/example/repository.git"], { stdio: "ignore" });
  return { storageDirectory, workspacePath };
}

async function start(storageDirectory: string) {
  const server = createLocalAppServer({ credential, serverVersion: "test", storageDirectory });
  liveServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function close(server: ReturnType<typeof createLocalAppServer>) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const index = liveServers.indexOf(server);
  if (index >= 0) liveServers.splice(index, 1);
}

function serverUrl(server: ReturnType<typeof createLocalAppServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function send(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  auth = credential,
  origin?: string,
  providerConfigurationHeader?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/app-server/request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(providerConfigurationHeader !== undefined
        ? { "x-legioncode-provider-configuration": providerConfigurationHeader }
        : {}),
    },
    body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method, params }),
  });
  return await response.json() as Record<string, unknown>;
}

function rawRequest(baseUrl: string, options: {
  method: string;
  host: string;
  authorization: string;
  body: string;
}) {
  const url = new URL(baseUrl);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: "/app-server/request",
      method: options.method,
      headers: { host: options.host, authorization: options.authorization },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}
