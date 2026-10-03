import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerMethodSchema,
  AppServerErrorSchema,
  AppServerRequestSchema,
  AppServerResponseSchema,
  type AppServerMethod,
  type AppServerRequest,
  type AppServerResponse,
} from "./protocol.js";
import { LocalPersistenceError } from "@repo/event-store/errors";
import { initializeAppServer } from "./handshake.js";
import type { LocalThreadService } from "./local-threads.js";
import type { LocalWorkspaceService } from "./local-workspace.js";

export type AppServerComposition = {
  environment: "local" | "hosted";
  serverId: string;
  serverVersion: string;
  workspaceService?: LocalWorkspaceService;
  threadService?: LocalThreadService;
};

export type AppServerHttpInput = {
  method: string;
  path: string;
  host?: string;
  origin?: string;
  authorization?: string;
  contentType?: string;
  rawBody: string;
};

export type AppServerHttpResult = {
  statusCode: number;
  headers: Record<string, string>;
  payload: unknown;
};

export type AppServerHttpBoundary = Pick<
  AppServerHttpInput,
  "method" | "path" | "host" | "origin" | "authorization" | "contentType"
>;

const JSON_HEADERS = { "content-type": "application/json" };

/** Validates transport security, parses the envelope, and explicitly dispatches one request. */
export async function handleAppServerHttpRequest(
  input: AppServerHttpInput,
  composition: AppServerComposition & { credential?: string },
): Promise<AppServerHttpResult> {
  const boundaryFailure = validateAppServerHttpBoundary(input, composition);
  if (boundaryFailure) return boundaryFailure;

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody) as unknown;
  } catch {
    return genericError(400, "invalid_request", "App Server request is invalid");
  }

  const method = knownMethod(body);
  if (method && hasIncompatibleVersion(body)) {
    return methodError(
      method,
      409,
      "protocol_incompatible",
      "App Server protocol version is incompatible",
    );
  }

  const parsed = AppServerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return method
      ? methodError(method, 400, "invalid_request", "App Server request is invalid")
      : genericError(400, "invalid_request", "App Server request is invalid");
  }

  const request = parsed.data;
  try {
    const result = await dispatch(request, composition);
    const response = AppServerResponseSchema.parse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: request.method,
      ok: true,
      result,
    });
    return { statusCode: 200, headers: JSON_HEADERS, payload: response };
  } catch (error) {
    if (error instanceof LocalPersistenceError) {
      return methodError(
        request.method,
        503,
        "server_unavailable",
        "App Server storage is unavailable",
      );
    }
    return methodError(
      request.method,
      400,
      "invalid_request",
      errorMessage(request.method),
    );
  }
}

export function validateAppServerHttpBoundary(
  input: AppServerHttpBoundary,
  composition: Pick<AppServerComposition, "environment"> & { credential?: string },
): AppServerHttpResult | null {
  const local = composition.environment === "local";
  if (local && (!isLoopbackHost(input.host) || !isLoopbackOrigin(input.origin))) {
    return genericError(403, "unauthorized", "App Server accepts loopback requests only");
  }
  if (local && !isAuthorized(input.authorization, composition.credential ?? "")) {
    return genericError(401, "unauthorized", "App Server credential is invalid");
  }
  if (input.method.toUpperCase() !== "POST" || input.path !== "/app-server/request") {
    return genericError(404, "invalid_request", "App Server route not found");
  }
  if (input.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return genericError(400, "invalid_request", "App Server request content type is invalid");
  }
  return null;
}

async function dispatch(
  request: AppServerRequest,
  composition: AppServerComposition,
): Promise<unknown> {
  switch (request.method) {
    case "initialize": {
      const result = initializeAppServer(
        {
          protocolVersion: request.protocolVersion,
          client: request.params.client,
          requestedCapabilities: request.params.requestedCapabilities,
        },
        {
          environment: composition.environment,
          serverId: composition.serverId,
          serverVersion: composition.serverVersion,
        },
      );
      if (result.statusCode !== 200) throw new Error("initialize failed");
      return result.payload;
    }
    case "workspace/current": {
      if (!composition.workspaceService) throw new Error("unsupported");
      return { grant: await composition.workspaceService.getCurrent() };
    }
    case "workspace/grant": {
      if (!composition.workspaceService || !("path" in request.params)) {
        throw new Error("unsupported or unresolved selection token");
      }
      return { grant: await composition.workspaceService.grant({ path: request.params.path }) };
    }
    case "workspace/revoke": {
      if (!composition.workspaceService) throw new Error("unsupported");
      await composition.workspaceService.revoke();
      return { revoked: true };
    }
    case "thread/list": {
      if (!composition.threadService) throw new Error("unsupported");
      return { threads: await composition.threadService.list() };
    }
    case "thread/create": {
      if (!composition.threadService) throw new Error("unsupported");
      return { thread: await composition.threadService.create(request.params) };
    }
    case "thread/get": {
      if (!composition.threadService) throw new Error("unsupported");
      return { thread: await composition.threadService.get(request.params.threadId) };
    }
    case "thread/rename": {
      if (!composition.threadService) throw new Error("unsupported");
      return {
        thread: await composition.threadService.rename(request.params.threadId, request.params),
      };
    }
    case "thread/archive": {
      if (!composition.threadService) throw new Error("unsupported");
      return { thread: await composition.threadService.archive(request.params.threadId) };
    }
    case "thread/unarchive": {
      if (!composition.threadService) throw new Error("unsupported");
      return { thread: await composition.threadService.unarchive(request.params.threadId) };
    }
  }
}

function knownMethod(body: unknown): AppServerMethod | null {
  if (!body || typeof body !== "object" || !("method" in body)) return null;
  const method = (body as { method?: unknown }).method;
  const parsed = AppServerMethodSchema.safeParse(method);
  return parsed.success ? parsed.data : null;
}

function hasIncompatibleVersion(body: unknown): boolean {
  return !!body && typeof body === "object" && "protocolVersion" in body &&
    (body as { protocolVersion?: unknown }).protocolVersion !== APP_SERVER_PROTOCOL_VERSION;
}

function methodError(
  method: AppServerMethod,
  statusCode: number,
  code:
    | "unauthorized"
    | "protocol_incompatible"
    | "invalid_request"
    | "server_unavailable",
  message: string,
): AppServerHttpResult {
  const response: AppServerResponse = AppServerResponseSchema.parse({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    method,
    ok: false,
    error: AppServerErrorSchema.parse({ code, message }),
  });
  return { statusCode, headers: JSON_HEADERS, payload: response };
}

function genericError(
  statusCode: number,
  code: "unauthorized" | "protocol_incompatible" | "invalid_request",
  message: string,
): AppServerHttpResult {
  return {
    statusCode,
    headers: JSON_HEADERS,
    payload: AppServerErrorSchema.parse({ code, message }),
  };
}

function errorMessage(method: AppServerMethod): string {
  if (method.startsWith("workspace/")) return "Workspace operation is invalid or unavailable";
  if (method.startsWith("thread/")) return "Thread operation is invalid or unavailable";
  return "App Server request is invalid";
}

function isAuthorized(header: string | undefined, credential: string): boolean {
  if (!credential || !header?.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const supplied = encoder.encode(header.slice("Bearer ".length));
  const expected = encoder.encode(credential);
  let difference = supplied.length ^ expected.length;
  const length = Math.max(supplied.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (supplied[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    return url.username === "" && url.password === "" && url.pathname === "/" &&
      url.search === "" && url.hash === "" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value || value === "null") return true;
  try {
    const url = new URL(value);
    return url.origin === value && url.username === "" && url.password === "" &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}
