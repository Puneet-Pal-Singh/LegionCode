import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerRequestSchema,
  AppServerResponseSchema,
  AppServerResultSchemas,
  LocalTurnReplayParamsSchema,
  LocalTurnContinuationRequestSchema,
  LocalTurnContinuationEventSchema,
  type LocalTurnContinuationRequest,
  type LocalTurnContinuationEvent,
  type LocalTurnStartParams,
  type AppServerMethod,
  type AppServerRequest,
} from "@legioncode/app-server/protocol";
import {
  ThreadIdSchema,
  ProviderIdSchema,
  type LocalWorkspaceGrant,
  type AppServerInitializeResponse,
  type LifecycleEvent,
  type LocalTurnAdmission,
  type LocalTurnIdentity,
  type Run,
  type ProviderId,
  type Thread,
  type Turn,
} from "@repo/platform-protocol";
import type {
  BYOKDiscoveredProviderModelsResponse,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import { z } from "zod";
import { followLifecycleEvents } from "./lifecycle-continuation.js";
import type { FollowLifecycleRequest } from "./lifecycle-types.js";

export type { AppServerRequest } from "@legioncode/app-server/protocol";

export type AppServerTransport = {
  request(envelope: AppServerRequest): Promise<unknown>;
  subscribe?(
    request: LocalTurnContinuationRequest,
    listener: (event: LocalTurnContinuationEvent) => void,
    onError: (error: Error) => void,
    options?: { signal?: AbortSignal },
  ): Promise<() => void>;
};

export type AppServerClientOptions = {
  clientId: string;
  clientVersion: string;
  transport: AppServerTransport;
};

export type WorkspaceGrantSource =
  | { selectionToken: string }
  | { path: string };

export type ProviderSelection = {
  providerId: ProviderId;
  modelId: string;
};

export type LocalTurnStartResponse = {
  identity: LocalTurnIdentity;
  run: Run;
  turn: Turn;
};
export type LocalTurnReplayResponse = {
  events: readonly LifecycleEvent[];
  nextSequence: number | null;
};

export class AppServerClientError extends Error {
  constructor(
    public readonly code:
      | "transport"
      | "invalid_response"
      | "server_error",
    message: string,
    public readonly method?: AppServerMethod,
    public readonly serverCode?: string,
  ) {
    super(message);
    this.name = "AppServerClientError";
  }
}

export type AppServerClient = {
  initialize(
    requestedCapabilities?: readonly string[],
  ): Promise<AppServerInitializeResponse>;
  getWorkspaceGrant(): Promise<LocalWorkspaceGrant | null>;
  grantWorkspace(source: WorkspaceGrantSource): Promise<LocalWorkspaceGrant>;
  revokeWorkspace(): Promise<void>;
  listThreads(): Promise<Thread[]>;
  createThread(title?: string): Promise<Thread>;
  getThread(threadId: Thread["id"]): Promise<Thread>;
  renameThread(threadId: Thread["id"], title: string): Promise<Thread>;
  archiveThread(threadId: Thread["id"]): Promise<Thread>;
  unarchiveThread(threadId: Thread["id"]): Promise<Thread>;
  getProviderCatalog(): Promise<ProviderRegistryEntry[]>;
  getProviderModels(providerId: string): Promise<BYOKDiscoveredProviderModelsResponse>;
  getProviderSelection(): Promise<ProviderSelection | null>;
  selectProvider(providerId: string, modelId: string): Promise<ProviderSelection>;
  clearProviderSelection(): Promise<null>;
  startTurn(input: LocalTurnStartParams): Promise<LocalTurnStartResponse>;
  getThreadHistory(workspaceId: string, threadId: string): Promise<readonly LocalTurnAdmission[]>;
  replayTurn(
    identity: LocalTurnIdentity,
    afterSequence: number | null,
    limit?: number,
  ): Promise<LocalTurnReplayResponse>;
  followTurn(
    identity: LocalTurnIdentity,
    afterSequence?: number | null,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<LifecycleEvent>;
};

export function createAppServerClient(
  options: AppServerClientOptions,
): AppServerClient {
  return {
    initialize: async (requestedCapabilities = []) => {
      const result = await request(options, {
        method: "initialize",
        params: {
          client: { id: options.clientId, version: options.clientVersion },
          requestedCapabilities: [...requestedCapabilities],
        },
      }, AppServerResultSchemas.initialize);
      return result;
    },
    getWorkspaceGrant: async () => {
      const result = await request(options, {
        method: "workspace/current",
        params: {},
      }, AppServerResultSchemas["workspace/current"]);
      return result.grant;
    },
    grantWorkspace: async (source) => {
      const result = await request(options, {
        method: "workspace/grant",
        params: source,
      }, AppServerResultSchemas["workspace/grant"]);
      const grant = result.grant;
      if (!grant) {
        throw invalidResponse("workspace/grant", "App Server did not return a workspace grant");
      }
      return grant;
    },
    revokeWorkspace: async () => {
      const result = await request(options, {
        method: "workspace/revoke",
        params: {},
      }, AppServerResultSchemas["workspace/revoke"]);
      void result;
    },
    listThreads: async () => {
      const result = await request(options, { method: "thread/list", params: {} }, AppServerResultSchemas["thread/list"]);
      return result.threads;
    },
    createThread: async (title) => {
      const result = await request(options, {
        method: "thread/create",
        params: title === undefined ? {} : { title },
      }, AppServerResultSchemas["thread/create"]);
      return result.thread;
    },
    getThread: async (threadId) => {
      const result = await request(options, {
        method: "thread/get",
        params: { threadId: ThreadIdSchema.parse(threadId) },
      }, AppServerResultSchemas["thread/get"]);
      return result.thread;
    },
    renameThread: async (threadId, title) => {
      const result = await request(options, {
        method: "thread/rename",
        params: { threadId: ThreadIdSchema.parse(threadId), title },
      }, AppServerResultSchemas["thread/rename"]);
      return result.thread;
    },
    archiveThread: async (threadId) => {
      const result = await request(options, {
        method: "thread/archive",
        params: { threadId: ThreadIdSchema.parse(threadId) },
      }, AppServerResultSchemas["thread/archive"]);
      return result.thread;
    },
    unarchiveThread: async (threadId) => {
      const result = await request(options, {
        method: "thread/unarchive",
        params: { threadId: ThreadIdSchema.parse(threadId) },
      }, AppServerResultSchemas["thread/unarchive"]);
      return result.thread;
    },
    getProviderCatalog: async () => {
      const result = await request(options, { method: "provider/catalog", params: {} }, AppServerResultSchemas["provider/catalog"]);
      return result.providers;
    },
    getProviderModels: async (providerId) => {
      const result = await request(options, {
        method: "provider/models",
        params: { providerId: ProviderIdSchema.parse(providerId) },
      }, AppServerResultSchemas["provider/models"]);
      return result;
    },
    getProviderSelection: async () => {
      const result = await request(options, { method: "provider/current", params: {} }, AppServerResultSchemas["provider/current"]);
      return result.selection;
    },
    selectProvider: async (providerId, modelId) => {
      const result = await request(options, {
        method: "provider/select",
        params: { providerId: ProviderIdSchema.parse(providerId), modelId },
      }, AppServerResultSchemas["provider/select"]);
      return result.selection;
    },
    clearProviderSelection: async () => {
      const result = await request(options, { method: "provider/clear", params: {} }, AppServerResultSchemas["provider/clear"]);
      return result.selection;
    },
    startTurn: async (input) => {
      const result = await request(options, {
        method: "turn/start",
        params: input,
      }, AppServerResultSchemas["turn/start"]);
      return result;
    },
    getThreadHistory: async (workspaceId, threadId) => {
      const result = await request(options, {
        method: "thread/history",
        params: { workspaceId, threadId },
      }, AppServerResultSchemas["thread/history"]);
      return result.entries;
    },
    replayTurn: async (identity, afterSequence, limit = 200) => {
      const params = LocalTurnReplayParamsSchema.parse({ identity, afterSequence, limit });
      const result = await request(options, {
        method: "turn/replay",
        params,
      }, AppServerResultSchemas["turn/replay"]);
      return result;
    },
    followTurn: (identity, afterSequence = null, operationOptions) => {
      const continuation = options.transport.subscribe;
      return followLocalTurn({
        identity,
        afterSequence,
        options: operationOptions,
        replay: async (cursor, limit) => {
          const params = LocalTurnReplayParamsSchema.parse({ identity, afterSequence: cursor, limit });
          return await request(options, {
            method: "turn/replay",
            params,
          }, AppServerResultSchemas["turn/replay"]);
        },
        ...(continuation
          ? {
              subscribe: async (cursor, onEvent, onError, subscribeOptions) => {
                const cleanUp = await continuation.call(options.transport, LocalTurnContinuationRequestSchema.parse({
                  protocolVersion: APP_SERVER_PROTOCOL_VERSION,
                  identity,
                  afterSequence: cursor,
                }), onEvent, onError, subscribeOptions);
                return cleanUp;
              },
            }
          : {}),
      });
    },
  };
}

function followLocalTurn(input: {
  identity: LocalTurnIdentity;
  afterSequence: number | null;
  options?: { signal?: AbortSignal };
  replay(
    afterSequence: number | null,
    limit: number,
    options?: { signal?: AbortSignal },
  ): Promise<LocalTurnReplayResponse>;
  subscribe?(
    afterSequence: number | null,
    onEvent: (event: LocalTurnContinuationEvent) => void,
    onError: (error: Error) => void,
    options?: { signal?: AbortSignal },
  ): Promise<() => void>;
}): AsyncIterable<LifecycleEvent> {
  const request: FollowLifecycleRequest = {
    turnId: input.identity.turnId,
    afterSequence: input.afterSequence,
    replayLimit: 200,
  };
  return followLifecycleEvents({
    request,
    options: input.options,
    replay: async ({ afterSequence, limit }) =>
      input.replay(afterSequence ?? null, limit ?? 200, input.options),
    ...(input.subscribe
      ? {
          subscribe: async ({ afterSequence }) => {
            return createContinuationIterable(input.identity, input.options, (onEvent, onError) =>
              input.subscribe?.(afterSequence ?? null, onEvent, onError, input.options) ??
                Promise.reject(new Error("Local Turn continuation is unavailable")),
            );
          },
        }
      : {}),
  });
}

function createContinuationIterable(
  identity: LocalTurnIdentity,
  options: { signal?: AbortSignal } | undefined,
  subscribe: (
    onEvent: (event: LocalTurnContinuationEvent) => void,
    onError: (error: Error) => void,
  ) => Promise<() => void>,
): Promise<AsyncIterable<LifecycleEvent>> {
  const events: LifecycleEvent[] = [];
  const waiters: Array<{
    resolve(value: IteratorResult<LifecycleEvent>): void;
    reject(error: Error): void;
  }> = [];
  let closed = false;
  let failure: Error | null = null;
  let unsubscribe: (() => void) | null = null;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    failure = error ?? null;
    options?.signal?.removeEventListener("abort", onAbort);
    unsubscribe?.();
    for (const waiter of waiters.splice(0)) {
      if (failure) waiter.reject(failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  };
  const onAbort = () => close();
  const onError = (error: Error) => close(error);
  const onEvent = (envelope: LocalTurnContinuationEvent) => {
    const parsed = LocalTurnContinuationEventSchema.parse(envelope);
    if (!sameIdentity(parsed.identity, identity) || parsed.event.turnId !== identity.turnId) {
      close(invalidResponse("turn/replay", "Local Turn continuation identity did not match"));
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: parsed.event });
    else events.push(parsed.event);
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.signal?.aborted) onAbort();
  return (async () => {
    if (!closed) unsubscribe = await subscribe(onEvent, onError);
    if (closed) unsubscribe?.();
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (events.length > 0) return { done: false as const, value: events.shift()! };
            if (failure) throw failure;
            if (closed) return { done: true as const, value: undefined };
            return await new Promise<IteratorResult<LifecycleEvent>>((resolve, reject) => waiters.push({ resolve, reject }));
          },
          return: async () => {
            close();
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  })();
}

function sameIdentity(left: LocalTurnIdentity, right: LocalTurnIdentity): boolean {
  return left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.runAttemptId === right.runAttemptId;
}

async function request<Schema extends z.ZodTypeAny>(
  options: AppServerClientOptions,
  requestInput: Omit<AppServerRequest, "protocolVersion">,
  resultSchema: Schema,
): Promise<z.output<Schema>> {
  const envelope = AppServerRequestSchema.parse({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    ...requestInput,
  });

  let payload: unknown;
  try {
    payload = await options.transport.request(envelope);
  } catch {
    throw new AppServerClientError("transport", "App Server request failed", envelope.method);
  }

  const parsed = AppServerResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.method !== envelope.method) {
    throw invalidResponse(envelope.method, "App Server returned an invalid response envelope");
  }

  if (parsed.data.ok === false) {
    throw new AppServerClientError(
      "server_error",
      parsed.data.error.message,
      envelope.method,
      parsed.data.error.code,
    );
  }
  return resultSchema.parse(parsed.data.result);
}

function invalidResponse(method: AppServerMethod, message: string) {
  return new AppServerClientError("invalid_response", message, method);
}
