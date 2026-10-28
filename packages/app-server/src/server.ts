import type { BYOKPreference, BYOKPreferencesUpdateRequest, BYOKResolution, BYOKResolveRequest } from "@repo/shared-types";
import type { BYOKCredential, BYOKCredentialConnectRequest, BYOKCredentialUpdateRequest, BYOKCredentialValidateRequest, BYOKCredentialValidateResponse } from "@repo/shared-types";
import type { BYOKDiscoveredProviderModelsQuery, BYOKDiscoveredProviderModelsResponse, BYOKDiscoveredProviderModelsRefreshResponse, NormalizedProviderError, ProviderRegistryEntry } from "@repo/shared-types";
import type { HostedWorkspaceListResponse, HostedWorkspaceSelection, HostedWorkspaceSelectRequest } from "@repo/platform-protocol";
import type { HostedSession, HostedSessionCreateRequest, HostedSessionPullRequestsResponse, HostedSessionReadReceipt, HostedSessionRenameRequest, HostedSessionWorkspaceContext, HostedSessionWorkspaceContextRequest, HostedSessionsResponse, TurnId, TurnScopeBootstrap } from "@repo/platform-protocol";
import type { ConversationHistoryRequest, ConversationHistoryResponse, AppServerError } from "@repo/platform-protocol";
import type {
  CompactTurnRequest,
  CompactTurnResponse,
  InterruptTurnResponse,
  GetTurnDiffRequest,
  GetTurnDiffResponse,
  LifecycleEvent,
  ReplayLifecycleEventsRequest,
  ReplayLifecycleEventsResponse,
  SubmitLifecycleApprovalRequest,
  ThreadInputCommand,
} from "@repo/platform-protocol";
import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerMethodSchema,
  AppServerErrorSchema,
  AppServerProviderErrorSchema,
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
import type { LocalProviderService, ProviderConfiguration } from "./local-providers.js";

export type AppServerComposition = {
  environment: "local" | "hosted";
  serverId: string;
  serverVersion: string;
  workspaceService?: LocalWorkspaceService;
  hostedWorkspaceService?: {
    list(): Promise<HostedWorkspaceListResponse>;
    select(params: HostedWorkspaceSelectRequest): Promise<{ selection: HostedWorkspaceSelection }>;
  };
  threadService?: LocalThreadService;
  providerService?: LocalProviderService;
  hostedProviderDiscoveryService?: {
    catalog(runId: string): Promise<{ providers: ProviderRegistryEntry[] }>;
    models(runId: string, providerId: string, query?: BYOKDiscoveredProviderModelsQuery): Promise<BYOKDiscoveredProviderModelsResponse>;
    refresh(runId: string, providerId: string): Promise<BYOKDiscoveredProviderModelsRefreshResponse>;
  };
  hostedProviderCredentialService?: {
    list(runId: string): Promise<BYOKCredential[]>;
    connect(runId: string, request: BYOKCredentialConnectRequest): Promise<BYOKCredential>;
    update(runId: string, credentialId: string, request: BYOKCredentialUpdateRequest): Promise<BYOKCredential>;
    disconnect(runId: string, credentialId: string): Promise<void>;
    validate(runId: string, credentialId: string, request: BYOKCredentialValidateRequest): Promise<BYOKCredentialValidateResponse>;
  };
  hostedProviderPreferenceService?: {
    read(runId: string): Promise<BYOKPreference>;
    update(runId: string, request: BYOKPreferencesUpdateRequest): Promise<BYOKPreference>;
    resolve(runId: string, request: BYOKResolveRequest): Promise<BYOKResolution>;
  };
  providerConfiguration?: ProviderConfiguration;
  sessionMetadataService?: {
    list(): Promise<HostedSessionsResponse>;
    listArchived(): Promise<{ sessions: HostedSession[] }>;
    readReceipt(params: { sessionId: string; terminalTurnId: TurnId }): Promise<HostedSessionReadReceipt>;
    workspaceContext(params: HostedSessionWorkspaceContextRequest): Promise<HostedSessionWorkspaceContext>;
    create(params: HostedSessionCreateRequest): Promise<{ session: HostedSession }>;
    rename(params: HostedSessionRenameRequest): Promise<{ session: HostedSession }>;
    pin(sessionId: string): Promise<{ session: HostedSession }>;
    unpin(sessionId: string): Promise<{ session: HostedSession }>;
    archive(sessionId: string): Promise<{ session: HostedSession }>;
    unarchive(sessionId: string): Promise<{ session: HostedSession }>;
  deleteArchived(sessionId: string): Promise<{ deleted: true }>;
  };
  conversationHistoryService?: {
    readPage(params: ConversationHistoryRequest): Promise<ConversationHistoryResponse>;
  };
  hostedSessionPullRequestService?: {
    read(sessionId: string): Promise<HostedSessionPullRequestsResponse>;
  };
  hostedTurnScopeService?: {
    reserve(params: Extract<AppServerRequest, { method: "turn/reserve" }>['params']): Promise<TurnScopeBootstrap>;
    read(params: Extract<AppServerRequest, { method: "turn/scope" }>['params']): Promise<TurnScopeBootstrap>;
  };
  hostedTurnCommandsService?: {
    interruptTurn(params: Extract<AppServerRequest, { method: "turn/interrupt" }>["params"]): Promise<InterruptTurnResponse>;
  };
  hostedThreadInputOperationsService?: {
    execute(command: ThreadInputCommand): Promise<AppServerMethodOutcome>;
  };
  hostedLifecycleOperationsService?: {
    replayLifecycleEvents(params: ReplayLifecycleEventsRequest): Promise<ReplayLifecycleEventsResponse>;
    getTurnDiff(params: GetTurnDiffRequest): Promise<GetTurnDiffResponse>;
    submitLifecycleApproval(params: SubmitLifecycleApprovalRequest): Promise<LifecycleEvent>;
    compactTurn(params: CompactTurnRequest): Promise<CompactTurnResponse>;
  };
};

/** A composed owner can preserve an explicit domain failure at the validated boundary. */
export class AppServerOperationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: AppServerError["code"],
    message: string,
    readonly operationCode?: string,
    readonly retryable?: boolean,
    readonly correlationId?: string,
    readonly metadata?: Record<string, unknown>,
  ) { super(message); }
}

/** Internal composition result for operations whose existing HTTP status is meaningful. */
export class AppServerMethodOutcome {
  constructor(
    readonly statusCode: 200 | 201 | 202 | 409,
    readonly result: unknown,
  ) {}
}

/** Preserves the existing provider error contract across hosted dispatch. */
export class AppServerProviderOperationError extends Error {
  constructor(readonly statusCode: number, readonly providerError: NormalizedProviderError) {
    super(providerError.message);
  }
}

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
    const dispatched = await dispatch(request, composition);
    const statusCode = dispatched instanceof AppServerMethodOutcome
      ? dispatched.statusCode
      : 200;
    const result = dispatched instanceof AppServerMethodOutcome
      ? dispatched.result
      : dispatched;
    const response = AppServerResponseSchema.parse({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: request.method,
      ok: true,
      result,
    });
    return { statusCode, headers: JSON_HEADERS, payload: response };
  } catch (error) {
    if (error instanceof AppServerProviderOperationError) {
      return {
        statusCode: error.statusCode, headers: JSON_HEADERS,
        payload: AppServerResponseSchema.parse({ protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: request.method, ok: false,
          error: AppServerProviderErrorSchema.parse({ ...error.providerError, statusCode: error.statusCode }),
        }),
      };
    }
    if (error instanceof AppServerOperationError) {
      return methodError(request.method, error.statusCode, error.code, error.message,
        error.operationCode || error.retryable !== undefined || error.correlationId || error.metadata
          ? { statusCode: error.statusCode, ...(error.operationCode ? { operationCode: error.operationCode } : {}), ...(error.retryable !== undefined ? { retryable: error.retryable } : {}), ...(error.correlationId ? { correlationId: error.correlationId } : {}), ...(error.metadata ? { metadata: error.metadata } : {}) }
          : undefined);
    }
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
    case "session/list": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.list();
    }
    case "session/archived": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.listArchived();
    }
    case "session/readReceipt": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.readReceipt(request.params);
    }
    case "session/workspaceContext": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.workspaceContext(request.params);
    }
    case "session/pullRequests": {
      if (!composition.hostedSessionPullRequestService) throw new Error("unsupported");
      return composition.hostedSessionPullRequestService.read(request.params.sessionId);
    }
    case "turn/reserve": {
      if (!composition.hostedTurnScopeService) throw new Error("unsupported");
      return composition.hostedTurnScopeService.reserve(request.params);
    }
    case "turn/scope": {
      if (!composition.hostedTurnScopeService) throw new Error("unsupported");
      return composition.hostedTurnScopeService.read(request.params);
    }
    case "turn/interrupt": {
      if (!composition.hostedTurnCommandsService) throw new Error("unsupported");
      return composition.hostedTurnCommandsService.interruptTurn(request.params);
    }
    case "turn/steer":
    case "turn/resume":
    case "thread/input/enqueue":
    case "thread/input/list":
    case "thread/input/update":
    case "thread/input/remove":
    case "thread/input/steer":
    case "thread/input/start": {
      if (!composition.hostedThreadInputOperationsService) throw new Error("unsupported");
      return composition.hostedThreadInputOperationsService.execute(request.params);
    }
    case "turn/lifecycleEvents": {
      if (!composition.hostedLifecycleOperationsService) throw new Error("unsupported");
      return composition.hostedLifecycleOperationsService.replayLifecycleEvents(request.params);
    }
    case "turn/diff": {
      if (!composition.hostedLifecycleOperationsService) throw new Error("unsupported");
      return composition.hostedLifecycleOperationsService.getTurnDiff(request.params);
    }
    case "turn/approval": {
      if (!composition.hostedLifecycleOperationsService) throw new Error("unsupported");
      return composition.hostedLifecycleOperationsService.submitLifecycleApproval(request.params);
    }
    case "turn/compact": {
      if (!composition.hostedLifecycleOperationsService) throw new Error("unsupported");
      return composition.hostedLifecycleOperationsService.compactTurn(request.params);
    }
    case "session/create": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.create(request.params);
    }
    case "session/rename": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.rename(request.params);
    }
    case "session/pin": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.pin(request.params.sessionId);
    }
    case "session/unpin": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.unpin(request.params.sessionId);
    }
    case "session/archive": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.archive(request.params.sessionId);
    }
    case "session/unarchive": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.unarchive(request.params.sessionId);
    }
    case "session/delete": {
      if (!composition.sessionMetadataService) throw new Error("unsupported");
      return composition.sessionMetadataService.deleteArchived(request.params.sessionId);
    }
    case "session/history": {
      if (!composition.conversationHistoryService) throw new Error("unsupported");
      return composition.conversationHistoryService.readPage(request.params);
    }
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
    case "workspace/list": {
      if (!composition.hostedWorkspaceService) throw new Error("unsupported");
      return composition.hostedWorkspaceService.list();
    }
    case "workspace/select": {
      if (!composition.hostedWorkspaceService) throw new Error("unsupported");
      return composition.hostedWorkspaceService.select(request.params);
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
    case "provider/catalog": {
      if (composition.hostedProviderDiscoveryService) {
        if (!request.params.runId) throw new AppServerOperationError(400, "invalid_request", "Provider requests require a run ID");
        return composition.hostedProviderDiscoveryService.catalog(request.params.runId);
      }
      if (!composition.providerService) throw new Error("unsupported");
      return { providers: composition.providerService.listCatalog() };
    }
    case "provider/models": {
      if (composition.hostedProviderDiscoveryService) {
        if (!request.params.runId) throw new AppServerOperationError(400, "invalid_request", "Provider requests require a run ID");
        return composition.hostedProviderDiscoveryService.models(request.params.runId, request.params.providerId, request.params.query);
      }
      if (!composition.providerService) throw new Error("unsupported");
      return composition.providerService.listModels(request.params.providerId);
    }
    case "provider/models/refresh": {
      if (!composition.hostedProviderDiscoveryService) throw new Error("unsupported");
      return composition.hostedProviderDiscoveryService.refresh(request.params.runId, request.params.providerId);
    }
    case "provider/credentials/list": {
      if (!composition.hostedProviderCredentialService) throw new Error("unsupported");
      return composition.hostedProviderCredentialService.list(request.params.runId);
    }
    case "provider/credentials/connect": {
      if (!composition.hostedProviderCredentialService) throw new Error("unsupported");
      return composition.hostedProviderCredentialService.connect(request.params.runId, request.params.request);
    }
    case "provider/credentials/update": {
      if (!composition.hostedProviderCredentialService) throw new Error("unsupported");
      return composition.hostedProviderCredentialService.update(request.params.runId, request.params.credentialId, request.params.request);
    }
    case "provider/credentials/disconnect": {
      if (!composition.hostedProviderCredentialService) throw new Error("unsupported");
      await composition.hostedProviderCredentialService.disconnect(request.params.runId, request.params.credentialId);
      return { disconnected: true };
    }
    case "provider/credentials/validate": {
      if (!composition.hostedProviderCredentialService) throw new Error("unsupported");
      return composition.hostedProviderCredentialService.validate(request.params.runId, request.params.credentialId, request.params.request);
    }
    case "provider/preferences/read": {
      if (!composition.hostedProviderPreferenceService) throw new Error("unsupported");
      return composition.hostedProviderPreferenceService.read(request.params.runId);
    }
    case "provider/preferences/update": {
      if (!composition.hostedProviderPreferenceService) throw new Error("unsupported");
      return composition.hostedProviderPreferenceService.update(request.params.runId, request.params.request);
    }
    case "provider/resolve": {
      if (!composition.hostedProviderPreferenceService) throw new Error("unsupported");
      return composition.hostedProviderPreferenceService.resolve(request.params.runId, request.params.request);
    }
    case "provider/current": {
      if (!composition.providerService) throw new Error("unsupported");
      return { selection: await composition.providerService.getSelection() };
    }
    case "provider/select": {
      if (!composition.providerService) throw new Error("unsupported");
      return {
        selection: await composition.providerService.select(
          request.params,
          composition.providerConfiguration,
        ),
      };
    }
    case "provider/clear": {
      if (!composition.providerService) throw new Error("unsupported");
      await composition.providerService.clearSelection();
      return { selection: null };
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
  code: AppServerError["code"],
  message: string,
  details?: Pick<AppServerError, "statusCode" | "operationCode" | "retryable" | "correlationId" | "metadata">,
): AppServerHttpResult {
  const response: AppServerResponse = AppServerResponseSchema.parse({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    method,
    ok: false,
    error: AppServerErrorSchema.parse({ code, message, ...details }),
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
  if (method.startsWith("provider/")) return "Provider operation is invalid or unavailable";
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
