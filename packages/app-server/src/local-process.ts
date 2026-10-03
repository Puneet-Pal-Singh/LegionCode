import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { handleAppServerHttpRequest, validateAppServerHttpBoundary } from "./server.js";
import { LocalWorkspaceService } from "./local-workspace.js";
import { LocalThreadService } from "./local-threads.js";

const MAX_REQUEST_BYTES = 32 * 1024;

export type LocalAppServerStartConfig = {
  credential: string;
  serverVersion: string;
  storageDirectory: string;
};

export type LocalAppServerMessage =
  | { type: "ready"; baseUrl: string }
  | { type: "fatal" };

export type LocalAppServerParentPort = {
  postMessage(message: LocalAppServerMessage): void;
};

export function createLocalAppServer(config: LocalAppServerStartConfig) {
  const workspaceService = new LocalWorkspaceService({
    storageDirectory: config.storageDirectory,
  });
  const threadService = new LocalThreadService({
    storageDirectory: config.storageDirectory,
    getWorkspace: () => workspaceService.getCurrent(),
  });
  return createServer((request, response) => {
    void handleRequest(request, response, config, workspaceService, threadService);
  });
}

export function runLocalAppServerProcess(
  parentPort: LocalAppServerParentPort,
  config: LocalAppServerStartConfig,
): void {
  const server = createLocalAppServer(config);
  server.once("error", () => {
    parentPort.postMessage({ type: "fatal" });
    process.exit(1);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      parentPort.postMessage({ type: "fatal" });
      process.exit(1);
      return;
    }
    parentPort.postMessage({
      type: "ready",
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalAppServerStartConfig,
  workspaceService: LocalWorkspaceService,
  threadService: LocalThreadService,
): Promise<void> {
  const baseInput = {
    method: request.method ?? "",
    path: request.url ?? "/",
    host: request.headers.host,
    origin: request.headers.origin,
    authorization: request.headers.authorization,
    contentType: request.headers["content-type"],
  };
  const composition = {
    environment: "local" as const,
    serverId: "legioncode-local",
    serverVersion: config.serverVersion,
    credential: config.credential,
    workspaceService,
    threadService,
  };
  const boundaryFailure = validateAppServerHttpBoundary(baseInput, composition);
  if (boundaryFailure) {
    writeJson(response, boundaryFailure.statusCode, boundaryFailure.payload, boundaryFailure.headers);
    return;
  }
  const body = await readBody(request);
  if (body.tooLarge) {
    writeJson(response, 413, { code: "invalid_request", message: "App Server request is too large" });
    return;
  }
  if (body.timedOut) {
    writeJson(response, 408, { code: "invalid_request", message: "App Server request timed out" });
    return;
  }
  const result = await handleAppServerHttpRequest(
    {
      ...baseInput,
      rawBody: body.value,
    },
    composition,
  );
  writeJson(response, result.statusCode, result.payload, result.headers);
}

function readBody(
  request: IncomingMessage,
): Promise<{ value: string; tooLarge: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    const timer = setTimeout(() => {
      if (rejected) return;
      rejected = true;
      chunks.length = 0;
      request.resume();
      resolve({ value: "", tooLarge: false, timedOut: true });
    }, 15_000);
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        rejected = true;
        chunks.length = 0;
        clearTimeout(timer);
        request.resume();
        resolve({ value: "", tooLarge: true, timedOut: false });
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (rejected) return;
      clearTimeout(timer);
      resolve({ value: Buffer.concat(chunks).toString("utf8"), tooLarge: false, timedOut: false });
    });
    request.once("error", () => {
      if (!rejected) {
        clearTimeout(timer);
        resolve({ value: "", tooLarge: false, timedOut: false });
      }
    });
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}
