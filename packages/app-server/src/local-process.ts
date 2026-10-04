import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { LocalPersistence } from "@repo/event-store/local";
import { handleAppServerHttpRequest, validateAppServerHttpBoundary } from "./server.js";
import { LocalWorkspaceService } from "./local-workspace.js";
import { LocalThreadService } from "./local-threads.js";
import { LocalProviderService, ProviderConfigurationSchema } from "./local-providers.js";

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
  const persistence = new LocalPersistence({ storageDirectory: config.storageDirectory });
  try {
    const workspaceService = new LocalWorkspaceService({
      workspaceGrants: persistence.workspaceGrants,
    });
    const threadService = new LocalThreadService({
      events: persistence.events,
      getWorkspace: () => workspaceService.getCurrent(),
    });
    const providerService = new LocalProviderService({
      selectionStore: persistence.providerSelection,
    });
    const server = createServer((request, response) => {
      void handleRequest(request, response, config, workspaceService, threadService, providerService);
    });
    server.once("close", () => persistence.close());
    server.once("error", () => persistence.close());
    return server;
  } catch (error) {
    persistence.close();
    throw error;
  }
}

export function runLocalAppServerProcess(
  parentPort: LocalAppServerParentPort,
  config: LocalAppServerStartConfig,
): void {
  let server: ReturnType<typeof createLocalAppServer>;
  try {
    server = createLocalAppServer(config);
  } catch {
    parentPort.postMessage({ type: "fatal" });
    process.exit(1);
    return;
  }
  server.once("error", () => {
    parentPort.postMessage({ type: "fatal" });
    server.close(() => process.exit(1));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      parentPort.postMessage({ type: "fatal" });
      server.close(() => process.exit(1));
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
  providerService: LocalProviderService,
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
  const rawProviderConfiguration = request.headers["x-legioncode-provider-configuration"];
  let providerConfiguration: ReturnType<typeof ProviderConfigurationSchema.parse> | undefined;
  if (rawProviderConfiguration !== undefined) {
    if (typeof rawProviderConfiguration !== "string" || rawProviderConfiguration.length > 1_024) {
      writeJson(response, 400, { code: "invalid_request", message: "Provider configuration header is invalid" });
      return;
    }
    try {
      providerConfiguration = ProviderConfigurationSchema.parse(JSON.parse(rawProviderConfiguration) as unknown);
    } catch {
      writeJson(response, 400, { code: "invalid_request", message: "Provider configuration header is invalid" });
      return;
    }
  }
  const result = await handleAppServerHttpRequest(
    {
      ...baseInput,
      rawBody: body.value,
    },
    { ...composition, providerService, providerConfiguration },
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
