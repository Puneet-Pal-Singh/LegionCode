import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { initializeAppServer } from "./handshake.js";
import { LocalWorkspaceService } from "./local-workspace.js";

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

export function runLocalAppServerProcess(
  parentPort: LocalAppServerParentPort,
  config: LocalAppServerStartConfig,
): void {
  const workspaceService = new LocalWorkspaceService({
    storageDirectory: config.storageDirectory,
  });
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, workspaceService);
  });

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
): Promise<void> {
  response.setHeader(
    "access-control-allow-origin",
    request.headers.origin ?? "null",
  );
  if (!isLoopbackHost(request.headers.host) || !isLoopbackOrigin(request.headers.origin)) {
    writeJson(response, 403, {
      code: "unauthorized",
      message: "App Server accepts loopback requests only",
    });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, POST",
    });
    response.end();
    return;
  }
  if (!isAuthorized(request.headers.authorization, config.credential)) {
    writeJson(response, 401, {
      code: "unauthorized",
      message: "App Server credential is invalid",
    });
    return;
  }

  if (request.method === "GET" && request.url === "/workspaces/current") {
    try {
      writeJson(response, 200, { grant: await workspaceService.getCurrent() });
    } catch {
      writeJson(response, 500, {
        code: "invalid_request",
        message: "Stored workspace grant is unavailable",
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/workspaces/grant") {
    const body = await readBody(request);
    if (body.tooLarge) {
      writeJson(response, 413, {
        code: "invalid_request",
        message: "App Server request is too large",
      });
      return;
    }
    try {
      const grant = await workspaceService.grant(body.value);
      writeJson(response, 200, { grant });
    } catch {
      writeJson(response, 400, {
        code: "invalid_request",
        message: "Workspace grant is invalid",
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/workspaces/revoke") {
    try {
      await workspaceService.revoke();
      writeJson(response, 200, { grant: null });
    } catch {
      writeJson(response, 500, {
        code: "invalid_request",
        message: "Workspace grant could not be revoked",
      });
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/initialize") {
    writeJson(response, 404, {
      code: "invalid_request",
      message: "App Server route not found",
    });
    return;
  }

  const body = await readBody(request);
  if (body.tooLarge) {
    writeJson(response, 413, {
      code: "invalid_request",
      message: "App Server request is too large",
    });
    return;
  }
  const result = initializeAppServer(body.value, {
    environment: "local",
    serverId: "legioncode-local",
    serverVersion: config.serverVersion,
  });
  writeJson(response, result.statusCode, result.payload);
}

function isAuthorized(header: string | undefined, credential: string): boolean {
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(credential);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const hostname = value.startsWith("[")
    ? value.slice(1, value.indexOf("]"))
    : value.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  if (value === "null") {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function readBody(
  request: IncomingMessage,
): Promise<{ value: unknown | null; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        rejected = true;
        request.resume();
        resolve({ value: null, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (rejected) {
        return;
      }
      try {
        resolve({
          value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          tooLarge: false,
        });
      } catch {
        resolve({ value: null, tooLarge: false });
      }
    });
    request.once("error", () => resolve({ value: null, tooLarge: false }));
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}
