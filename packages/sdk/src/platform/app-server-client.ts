import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerErrorSchema,
  AppServerInitializeRequestSchema,
  AppServerInitializeResponseSchema,
  GrantLocalWorkspaceRequestSchema,
  LocalWorkspaceGrantResponseSchema,
  ThreadIdSchema,
  ThreadSchema,
  type LocalWorkspaceGrant,
  type AppServerInitializeResponse,
  type Thread,
} from "@repo/platform-protocol";
import { z } from "zod";

export type AppServerClientOptions = {
  baseUrl: string;
  credential?: string;
  clientId: string;
  clientVersion: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class AppServerHandshakeError extends Error {
  constructor(
    public readonly code:
      | "unauthorized"
      | "protocol_incompatible"
      | "invalid_request"
      | "invalid_response"
      | "transport",
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "AppServerHandshakeError";
  }
}

export type AppServerClient = {
  initialize(
    requestedCapabilities?: readonly string[],
  ): Promise<AppServerInitializeResponse>;
  getWorkspaceGrant(): Promise<LocalWorkspaceGrant | null>;
  grantWorkspace(path: string): Promise<LocalWorkspaceGrant>;
  revokeWorkspace(): Promise<void>;
  listThreads(): Promise<Thread[]>;
  createThread(title?: string): Promise<Thread>;
  getThread(threadId: Thread["id"]): Promise<Thread>;
  renameThread(threadId: Thread["id"], title: string): Promise<Thread>;
  archiveThread(threadId: Thread["id"]): Promise<Thread>;
  unarchiveThread(threadId: Thread["id"]): Promise<Thread>;
};

export function createAppServerClient(
  options: AppServerClientOptions,
): AppServerClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return {
    initialize: async (requestedCapabilities = []) => {
      const request = AppServerInitializeRequestSchema.parse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: {
          id: options.clientId,
          version: options.clientVersion,
        },
        requestedCapabilities: [...requestedCapabilities],
      });

      let response: Response;
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 5_000,
      );
      try {
        response = await fetchImpl(`${baseUrl}/initialize`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(options.credential
              ? { Authorization: `Bearer ${options.credential}` }
              : {}),
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch {
        throw new AppServerHandshakeError(
          "transport",
          "App Server is unreachable",
        );
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }

      const payload = await readJson(response);
      if (!response.ok) {
        const parsedError = AppServerErrorSchema.safeParse(payload);
        throw new AppServerHandshakeError(
          parsedError.success ? parsedError.data.code : "invalid_response",
          parsedError.success
            ? parsedError.data.message
            : `App Server rejected initialize (${response.status})`,
          response.status,
        );
      }

      const parsedResponse = AppServerInitializeResponseSchema.safeParse(payload);
      if (!parsedResponse.success) {
        throw new AppServerHandshakeError(
          "invalid_response",
          "App Server returned an invalid initialize response",
          response.status,
        );
      }
      return parsedResponse.data;
    },
    getWorkspaceGrant: async () => {
      const payload = await requestAppServer(options, baseUrl, "GET", "/workspaces/current");
      return parseWorkspaceResponse(payload).grant;
    },
    grantWorkspace: async (path) => {
      const request = GrantLocalWorkspaceRequestSchema.parse({ path });
      const payload = await requestAppServer(
        options,
        baseUrl,
        "POST",
        "/workspaces/grant",
        request,
      );
      return parseWorkspaceResponse(payload).grant ?? throwMissingGrant();
    },
    revokeWorkspace: async () => {
      const payload = await requestAppServer(
        options,
        baseUrl,
        "POST",
        "/workspaces/revoke",
      );
      parseWorkspaceResponse(payload);
    },
    listThreads: async () => {
      const payload = await requestAppServer(options, baseUrl, "GET", "/threads");
      return parseThreadListResponse(payload);
    },
    createThread: async (title) => {
      const payload = await requestAppServer(
        options,
        baseUrl,
        "POST",
        "/threads",
        title === undefined ? {} : { title },
      );
      return parseThreadResponse(payload);
    },
    getThread: async (threadId) => {
      const parsedThreadId = ThreadIdSchema.parse(threadId);
      const payload = await requestAppServer(
        options,
        baseUrl,
        "GET",
        `/threads/${encodeURIComponent(parsedThreadId)}`,
      );
      return parseThreadResponse(payload);
    },
    renameThread: async (threadId, title) => {
      const parsedThreadId = ThreadIdSchema.parse(threadId);
      const payload = await requestAppServer(
        options,
        baseUrl,
        "POST",
        `/threads/${encodeURIComponent(parsedThreadId)}/title`,
        { title },
      );
      return parseThreadResponse(payload);
    },
    archiveThread: async (threadId) => {
      const parsedThreadId = ThreadIdSchema.parse(threadId);
      const payload = await requestAppServer(
        options,
        baseUrl,
        "POST",
        `/threads/${encodeURIComponent(parsedThreadId)}/archive`,
      );
      return parseThreadResponse(payload);
    },
    unarchiveThread: async (threadId) => {
      const parsedThreadId = ThreadIdSchema.parse(threadId);
      const payload = await requestAppServer(
        options,
        baseUrl,
        "POST",
        `/threads/${encodeURIComponent(parsedThreadId)}/unarchive`,
      );
      return parseThreadResponse(payload);
    },
  };
}

async function requestAppServer(
  options: AppServerClientOptions,
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.credential
          ? { Authorization: `Bearer ${options.credential}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const parsedError = AppServerErrorSchema.safeParse(payload);
      throw new AppServerHandshakeError(
        parsedError.success ? parsedError.data.code : "invalid_response",
        parsedError.success
          ? parsedError.data.message
          : `App Server rejected ${method} ${path} (${response.status})`,
        response.status,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof AppServerHandshakeError) {
      throw error;
    }
    throw new AppServerHandshakeError("transport", "App Server is unreachable");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function parseWorkspaceResponse(payload: unknown) {
  const parsed = LocalWorkspaceGrantResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppServerHandshakeError(
      "invalid_response",
      "App Server returned an invalid workspace response",
    );
  }
  return parsed.data;
}

const ThreadResponseSchema = z.object({ thread: ThreadSchema }).strict();
const ThreadListResponseSchema = z.object({ threads: z.array(ThreadSchema) }).strict();

function parseThreadResponse(payload: unknown): Thread {
  const parsed = ThreadResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppServerHandshakeError("invalid_response", "App Server returned an invalid thread response");
  }
  return parsed.data.thread;
}

function parseThreadListResponse(payload: unknown): Thread[] {
  const parsed = ThreadListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppServerHandshakeError("invalid_response", "App Server returned an invalid thread list");
  }
  return parsed.data.threads;
}

function throwMissingGrant(): never {
  throw new AppServerHandshakeError(
    "invalid_response",
    "App Server did not return a workspace grant",
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AppServerHandshakeError(
      "invalid_response",
      "App Server returned invalid JSON",
      response.status,
    );
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
