import type { BYOKPreference, BYOKPreferencesUpdateRequest, BYOKResolution, BYOKResolveRequest } from "@repo/shared-types";
import type { BYOKCredential, BYOKCredentialConnectRequest, BYOKCredentialUpdateRequest, BYOKCredentialValidateRequest, BYOKCredentialValidateResponse } from "@repo/shared-types";
import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerRequestSchema,
  AppServerResponseSchema,
  AppServerResultSchemas,
  type AppServerMethod,
  type AppServerRequest,
  type AppServerFailureResponse,
} from "@legioncode/app-server/protocol";
import {
  type HostedWorkspaceListResponse, type HostedWorkspaceSelection, type HostedWorkspaceSelectRequest,
  type HostedSession,
  type HostedSessionCreateRequest,
  type HostedSessionReadReceipt,
  type HostedSessionWorkspaceContext,
  type ConversationHistoryRequest,
  type ConversationHistoryResponse,
  ThreadIdSchema,
  RunIdSchema,
  ProviderIdSchema,
  type LocalWorkspaceGrant,
  type AppServerInitializeResponse,
  type ProviderId,
  type Thread,
  type TurnScopeBootstrap,
  type TurnScopeReadQuery,
} from "@repo/platform-protocol";
import type {
  BYOKDiscoveredProviderModelsResponse,
  BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsRefreshResponse,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import { z } from "zod";
import { ConversationScopeHttpError } from "./conversation-scope-error.js";

export type { AppServerRequest } from "@legioncode/app-server/protocol";

export type AppServerTransport = {
  request(envelope: AppServerRequest): Promise<unknown>;
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

export class AppServerClientError extends Error {
  constructor(
    public readonly code:
      | "transport"
      | "invalid_response"
      | "server_error",
    message: string,
    public readonly method?: AppServerMethod,
    public readonly serverCode?: string,
    public readonly serverError?: AppServerFailureResponse["error"],
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppServerClientError";
  }
}

export type AppServerClient = {
  initialize(
    requestedCapabilities?: readonly string[],
  ): Promise<AppServerInitializeResponse>;
  listSessions(): Promise<HostedSession[]>;
  listArchivedSessions(): Promise<HostedSession[]>;
  getSessionWorkspaceContext(sessionId: string, runId?: string): Promise<HostedSessionWorkspaceContext>;
  acknowledgeSessionReadReceipt(sessionId: string, terminalTurnId: string): Promise<HostedSessionReadReceipt>;
  createSession(params: HostedSessionCreateRequest): Promise<HostedSession>;
  renameSession(sessionId: string, title: string): Promise<HostedSession>;
  pinSession(sessionId: string): Promise<HostedSession>;
  unpinSession(sessionId: string): Promise<HostedSession>;
  archiveSession(sessionId: string): Promise<HostedSession>;
  unarchiveSession(sessionId: string): Promise<HostedSession>;
  deleteArchivedSession(sessionId: string): Promise<void>;
  getConversationHistoryPage(params: ConversationHistoryRequest): Promise<ConversationHistoryResponse>;
  reserveTurnScope(params: Extract<AppServerRequest, { method: "turn/reserve" }>['params']): Promise<TurnScopeBootstrap>;
  getTurnScope(params: TurnScopeReadQuery): Promise<TurnScopeBootstrap | null>;
  listHostedWorkspaces(): Promise<HostedWorkspaceListResponse>;
  selectHostedWorkspace(params: HostedWorkspaceSelectRequest): Promise<HostedWorkspaceSelection>;
  getWorkspaceGrant(): Promise<LocalWorkspaceGrant | null>;
  grantWorkspace(source: WorkspaceGrantSource): Promise<LocalWorkspaceGrant>;
  revokeWorkspace(): Promise<void>;
  listThreads(): Promise<Thread[]>;
  createThread(title?: string): Promise<Thread>;
  getThread(threadId: Thread["id"]): Promise<Thread>;
  renameThread(threadId: Thread["id"], title: string): Promise<Thread>;
  archiveThread(threadId: Thread["id"]): Promise<Thread>;
  unarchiveThread(threadId: Thread["id"]): Promise<Thread>;
  getProviderCatalog(runId?: string): Promise<ProviderRegistryEntry[]>;
  getProviderModels(providerId: string, runId?: string, query?: BYOKDiscoveredProviderModelsQuery): Promise<BYOKDiscoveredProviderModelsResponse>;
  refreshProviderModels(providerId: string, runId: string): Promise<BYOKDiscoveredProviderModelsRefreshResponse>;
  listProviderCredentials(runId: string): Promise<BYOKCredential[]>;
  connectProviderCredential(runId: string, request: BYOKCredentialConnectRequest): Promise<BYOKCredential>;
  updateProviderCredential(runId: string, credentialId: string, request: BYOKCredentialUpdateRequest): Promise<BYOKCredential>;
  disconnectProviderCredential(runId: string, credentialId: string): Promise<void>;
  validateProviderCredential(runId: string, credentialId: string, request: BYOKCredentialValidateRequest): Promise<BYOKCredentialValidateResponse>;
  readProviderPreferences(runId: string): Promise<BYOKPreference>;
  updateProviderPreferences(runId: string, request: BYOKPreferencesUpdateRequest): Promise<BYOKPreference>;
  resolveProviderPreferences(runId: string, request: BYOKResolveRequest): Promise<BYOKResolution>;
  getProviderSelection(): Promise<ProviderSelection | null>;
  selectProvider(providerId: string, modelId: string): Promise<ProviderSelection>;
  clearProviderSelection(): Promise<null>;
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
    listSessions: async () => (await request(options, { method: "session/list", params: {} }, AppServerResultSchemas["session/list"])).sessions,
    listArchivedSessions: async () => (await request(options, { method: "session/archived", params: {} }, AppServerResultSchemas["session/archived"])).sessions,
    getSessionWorkspaceContext: async (sessionId, runId) => request(options, {
      method: "session/workspaceContext", params: { sessionId, ...(runId ? { runId } : {}) },
    }, AppServerResultSchemas["session/workspaceContext"]),
    acknowledgeSessionReadReceipt: async (sessionId, terminalTurnId) => request(options, {
      method: "session/readReceipt", params: { sessionId, terminalTurnId },
    }, AppServerResultSchemas["session/readReceipt"]),
    createSession: async (params) => (await request(options, { method: "session/create", params }, AppServerResultSchemas["session/create"])).session,
    renameSession: async (sessionId, title) => (await request(options, { method: "session/rename", params: { sessionId, title } }, AppServerResultSchemas["session/rename"])).session,
    pinSession: async (sessionId) => (await request(options, { method: "session/pin", params: { sessionId } }, AppServerResultSchemas["session/pin"])).session,
    unpinSession: async (sessionId) => (await request(options, { method: "session/unpin", params: { sessionId } }, AppServerResultSchemas["session/unpin"])).session,
    archiveSession: async (sessionId) => (await request(options, { method: "session/archive", params: { sessionId } }, AppServerResultSchemas["session/archive"])).session,
    unarchiveSession: async (sessionId) => (await request(options, { method: "session/unarchive", params: { sessionId } }, AppServerResultSchemas["session/unarchive"])).session,
    deleteArchivedSession: async (sessionId) => { await request(options, { method: "session/delete", params: { sessionId } }, AppServerResultSchemas["session/delete"]); },
    getConversationHistoryPage: async (params) => request(options, {
      method: "session/history", params,
    }, AppServerResultSchemas["session/history"]),
    reserveTurnScope: async (params) => turnScopeRequest(options, {
      method: "turn/reserve", params,
    }, AppServerResultSchemas["turn/reserve"]),
    getTurnScope: async (params) => {
      try {
        return await turnScopeRequest(options, { method: "turn/scope", params }, AppServerResultSchemas["turn/scope"]);
      } catch (error) {
        if (error instanceof ConversationScopeHttpError && error.status === 404) return null;
        throw error;
      }
    },
    listHostedWorkspaces: async () => request(options, { method: "workspace/list", params: {} }, AppServerResultSchemas["workspace/list"]),
    selectHostedWorkspace: async (params) => (await request(options, { method: "workspace/select", params }, AppServerResultSchemas["workspace/select"])).selection,
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
    getProviderCatalog: async (runId) => {
      const result = await request(options, { method: "provider/catalog", params: runId === undefined ? {} : { runId: RunIdSchema.parse(runId) } }, AppServerResultSchemas["provider/catalog"]);
      return result.providers;
    },
    getProviderModels: async (providerId, runId, query) => {
      const result = await request(options, {
        method: "provider/models",
        params: { providerId: ProviderIdSchema.parse(providerId), ...(runId === undefined ? {} : { runId: RunIdSchema.parse(runId) }), ...(query === undefined ? {} : { query }) },
      }, AppServerResultSchemas["provider/models"]);
      return result;
    },
    refreshProviderModels: async (providerId, runId) => request(options, { method: "provider/models/refresh", params: { providerId, runId: RunIdSchema.parse(runId) } }, AppServerResultSchemas["provider/models/refresh"]),
    listProviderCredentials: async (runId) => request(options, { method: "provider/credentials/list", params: { runId: RunIdSchema.parse(runId) } }, AppServerResultSchemas["provider/credentials/list"]),
    connectProviderCredential: async (runId, payload) => request(options, { method: "provider/credentials/connect", params: { runId: RunIdSchema.parse(runId), request: payload } }, AppServerResultSchemas["provider/credentials/connect"]),
    updateProviderCredential: async (runId, credentialId, payload) => request(options, { method: "provider/credentials/update", params: { runId: RunIdSchema.parse(runId), credentialId, request: payload } }, AppServerResultSchemas["provider/credentials/update"]),
    disconnectProviderCredential: async (runId, credentialId) => { await request(options, { method: "provider/credentials/disconnect", params: { runId: RunIdSchema.parse(runId), credentialId } }, AppServerResultSchemas["provider/credentials/disconnect"]); },
    validateProviderCredential: async (runId, credentialId, payload) => request(options, { method: "provider/credentials/validate", params: { runId: RunIdSchema.parse(runId), credentialId, request: payload } }, AppServerResultSchemas["provider/credentials/validate"]),
    readProviderPreferences: async (runId) => request(options, { method: "provider/preferences/read", params: { runId: RunIdSchema.parse(runId) } }, AppServerResultSchemas["provider/preferences/read"]),
    updateProviderPreferences: async (runId, payload) => request(options, { method: "provider/preferences/update", params: { runId: RunIdSchema.parse(runId), request: payload } }, AppServerResultSchemas["provider/preferences/update"]),
    resolveProviderPreferences: async (runId, payload) => request(options, { method: "provider/resolve", params: { runId: RunIdSchema.parse(runId), request: payload } }, AppServerResultSchemas["provider/resolve"]),
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
  };
}

async function turnScopeRequest<Schema extends z.ZodTypeAny>(
  options: AppServerClientOptions,
  requestInput: Omit<AppServerRequest, "protocolVersion">,
  resultSchema: Schema,
): Promise<z.output<Schema>> {
  try {
    return await request(options, requestInput, resultSchema);
  } catch (error) {
    if (error instanceof AppServerClientError && error.code === "server_error" && error.serverError) {
      const serverError = error.serverError;
      const statusByCode: Record<string, number> = {
        not_found: 404, unauthorized: 401, conflict: 409, invalid_request: 400, server_unavailable: 503,
      };
      const status = serverError.statusCode ?? statusByCode[serverError.code] ?? 500;
      const operationCode = "operationCode" in serverError && typeof serverError.operationCode === "string"
        ? serverError.operationCode
        : serverError.code;
      const retryable = "retryable" in serverError && typeof serverError.retryable === "boolean"
        ? serverError.retryable
        : undefined;
      throw new ConversationScopeHttpError({
        status,
        code: operationCode,
        message: serverError.message,
        retryable,
      });
    }
    if (error instanceof AppServerClientError && error.code === "transport") {
      const cause = error.cause;
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      if (cause && typeof cause === "object" && "name" in cause && cause.name === "AppServerTransportError") {
        const transportError = cause as { code?: unknown; statusCode?: unknown; serverCode?: unknown; message?: unknown; cause?: unknown };
        if (transportError.code === "aborted") {
          throw transportError.cause instanceof Error && transportError.cause.name === "AbortError"
            ? transportError.cause
            : new DOMException("The operation was aborted.", "AbortError");
        }
        if (typeof transportError.statusCode === "number" && transportError.statusCode >= 400) {
          throw new ConversationScopeHttpError({
            status: transportError.statusCode,
            code: typeof transportError.serverCode === "string" ? transportError.serverCode : `HTTP_${transportError.statusCode}`,
            message: typeof transportError.message === "string" ? transportError.message : "App Server request failed",
          });
        }
        if (transportError.cause !== undefined) throw transportError.cause;
        throw cause;
      }
      if (cause !== undefined) throw cause;
    }
    throw error;
  }
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
  } catch (error) {
    throw new AppServerClientError("transport", "App Server request failed", envelope.method, undefined, undefined, error);
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
      parsed.data.error,
    );
  }
  return resultSchema.parse(parsed.data.result);
}

function invalidResponse(method: AppServerMethod, message: string) {
  return new AppServerClientError("invalid_response", message, method);
}
