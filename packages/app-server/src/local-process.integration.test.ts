import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_SERVER_PROTOCOL_VERSION } from "./protocol.js";
import { createLocalAppServer } from "./local-process.js";

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
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legioncode-app-server-http-"));
  temporaryDirectories.push(root);
  const storageDirectory = join(root, "storage");
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
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/app-server/request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
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
