import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerRequestSchema,
  AppServerResponseSchema,
  AppServerResultSchemas,
  type AppServerMethod,
  type AppServerRequest,
} from "@legioncode/app-server/protocol";
import {
  type ConversationHistoryRequest,
  type ConversationHistoryResponse,
  ThreadIdSchema,
  ProviderIdSchema,
  type LocalWorkspaceGrant,
  type AppServerInitializeResponse,
  type ProviderId,
  type Thread,
} from "@repo/platform-protocol";
import type {
  BYOKDiscoveredProviderModelsResponse,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import { z } from "zod";

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
  ) {
    super(message);
    this.name = "AppServerClientError";
  }
}

export type AppServerClient = {
  initialize(
    requestedCapabilities?: readonly string[],
  ): Promise<AppServerInitializeResponse>;
  getConversationHistoryPage(params: ConversationHistoryRequest): Promise<ConversationHistoryResponse>;
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
    getConversationHistoryPage: async (params) => request(options, {
      method: "session/history", params,
    }, AppServerResultSchemas["session/history"]),
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
  };
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
