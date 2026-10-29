import {
  ArtifactIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  type ArtifactId,
} from "@repo/platform-protocol";
import type { ThreadInputCommand } from "@repo/platform-protocol";
import {
  PlatformClientOperationError,
  PlatformClientContractError,
  parsePlatformOperationErrorCode,
  parseProtocolErrorEnvelope,
} from "./errors.js";
import { createAppServerClient, AppServerClientError } from "./app-server-client.js";
import { createAppServerHttpTransport, AppServerTransportError } from "./app-server-http-transport.js";
import { AppServerErrorSchema, AppServerFailureResponseSchema } from "@legioncode/app-server/protocol";
import type {
  SubmitUserInputResponseRequest,
} from "./lifecycle-types.js";
import type {
  ListArtifactsRequest,
  ListThreadsRequest,
  PlatformClientOperationOptions,
  PlatformClientTransport,
  ReplayRunEventsRequest,
  SubmitApprovalRequest,
} from "./types.js";

const DEFAULT_RESPONSE_PREVIEW_LIMIT = 120;
const PROTECTED_HEADERS = new Set(["content-type", "accept"]);
type HostedLifecycleMethod = "turn/interrupt" | "turn/lifecycleEvents" | "turn/diff" | "turn/approval" | "turn/compact";
type HostedOperationError = PlatformClientOperationError | PlatformClientContractError;
type HostedThreadInputMethod = "turn/steer" | "turn/resume" |
  "thread/input/enqueue" | "thread/input/list" | "thread/input/update" |
  "thread/input/remove" | "thread/input/steer" | "thread/input/start";

export interface PlatformHttpTransportOptions {
  baseUrl: string;
  getHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  credentials?: RequestCredentials;
  responsePreviewLimit?: number;
}

export function createPlatformHttpTransport(
  options: PlatformHttpTransportOptions,
): PlatformClientTransport {
  const request = createTransportRequest(options);
  const hostedOperation = async <T>(
    method: HostedLifecycleMethod,
    signal: AbortSignal | undefined,
    action: (client: ReturnType<typeof createAppServerClient>) => Promise<T>,
  ): Promise<T> => {
    const suppliedHeaders = new Headers(options.getHeaders?.() ?? {});
    const authorization = suppliedHeaders.get("authorization");
    const client = createAppServerClient({
      clientId: "legioncode-platform",
      clientVersion: "0.1.0",
      transport: createAppServerHttpTransport({
        baseUrl: options.baseUrl,
        credentials: options.credentials ?? "include",
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (authorization !== null) headers.set("Authorization", authorization);
          return (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(input, { ...init, headers });
        },
        timeoutMs: null,
        maxResponseBytes: null,
        responsePreviewLimit: options.responsePreviewLimit ?? DEFAULT_RESPONSE_PREVIEW_LIMIT,
        signal,
        requestHeaders: () => Object.fromEntries(suppliedHeaders),
      }),
    });
    try {
      return await action(client);
    } catch (error) {
      throw mapHostedLifecycleError(error, method);
    }
  };
  const hostedThreadInputOperation = async <T>(
    command: ThreadInputCommand,
    signal: AbortSignal | undefined,
    action: (client: ReturnType<typeof createAppServerClient>) => Promise<T>,
  ): Promise<unknown> => {
    const suppliedHeaders = new Headers(options.getHeaders?.() ?? {});
    const authorization = suppliedHeaders.get("authorization");
    let responseStatus: number | undefined;
    const client = createAppServerClient({
      clientId: "legioncode-platform",
      clientVersion: "0.1.0",
      transport: createAppServerHttpTransport({
        baseUrl: options.baseUrl,
        credentials: options.credentials ?? "include",
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (authorization !== null) headers.set("Authorization", authorization);
          const response = await (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(input, { ...init, headers });
          responseStatus = response.status;
          return response;
        },
        timeoutMs: null,
        maxResponseBytes: null,
        acceptThreadInputConflict: true,
        responsePreviewLimit: options.responsePreviewLimit ?? DEFAULT_RESPONSE_PREVIEW_LIMIT,
        signal,
        requestHeaders: (envelope) => ({
          ...Object.fromEntries(suppliedHeaders),
          ...(isLargeThreadInputCommand(command) && envelope.method === threadInputMethod(command)
            ? { "X-LegionCode-AppServer-Method": envelope.method }
            : {}),
        }),
      }),
    });
    try {
      const result = await action(client);
      return responseStatus === 409 && command.operation !== "thread.input.list"
        ? { kind: "thread-input-conflict", payload: result } satisfies ThreadInputConflictResponse
        : result;
    } catch (error) {
      throw mapHostedThreadInputError(error, responseStatus, command.operation);
    }
  };

  return {
    submitHostedChat: async (payload, operationOptions) => {
      const suppliedHeaders = new Headers(options.getHeaders?.() ?? {});
      const authorization = suppliedHeaders.get("authorization");
      const client = createAppServerClient({
        clientId: "legioncode-platform",
        clientVersion: "0.1.0",
        transport: createAppServerHttpTransport({
          baseUrl: options.baseUrl,
          credentials: options.credentials ?? "include",
          fetchImpl: async (input, init) => {
            const headers = new Headers(init?.headers);
            if (authorization !== null) headers.set("Authorization", authorization);
            return (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(input, { ...init, headers });
          },
          timeoutMs: null,
          maxResponseBytes: null,
          responsePreviewLimit: options.responsePreviewLimit ?? DEFAULT_RESPONSE_PREVIEW_LIMIT,
          signal: operationOptions?.signal,
          requestHeaders: (envelope) => ({
            ...Object.fromEntries(suppliedHeaders),
            ...(envelope.method === "turn/submit"
              ? { "X-LegionCode-AppServer-Method": envelope.method }
              : {}),
          }),
        }),
      });
      return client.submitHostedChat(
        payload,
        operationOptions?.beforeSendHostedChatEnvelope ?? ((serializedEnvelope) => serializedEnvelope),
        operationOptions?.onChatSubmissionResponse,
      );
    },
    createThread: (payload, options) =>
      request.json("POST", "/threads", payload, options),
    createRun: (payload, options) =>
      request.json("POST", "/runs", payload, options),
    startTurn: (payload, options) =>
      request.json("POST", "/turns", payload, options),
    getThread: (threadId, options) =>
      request.json("GET", buildThreadPath(threadId), undefined, options),
    listThreads: (payload, options) =>
      request.json("GET", buildListThreadsPath(payload), undefined, options),
    getRun: (runId, options) =>
      request.json("GET", buildRunPath(runId), undefined, options),
    replayRunEvents: (payload, options) =>
      request.json(
        "GET",
        buildReplayRunEventsPath(payload),
        undefined,
        options,
      ),
    replayLifecycleEvents: (payload, options) => hostedOperation("turn/lifecycleEvents", options?.signal, (client) => client.replayLifecycleEvents(payload)),
    interruptTurn: (payload, options) =>
      hostedOperation("turn/interrupt", options?.signal, (client) => client.interruptTurn(payload)),
    compactTurn: (payload, options) => hostedOperation("turn/compact", options?.signal, (client) => client.compactTurn(payload)),
    submitApproval: (payload, options) =>
      request.json("POST", buildApprovalPath(payload), payload, options),
    submitLifecycleApproval: (payload, options) => hostedOperation("turn/approval", options?.signal, (client) => client.submitLifecycleApproval(payload)),
    submitUserInputResponse: (payload, options) =>
      request.json(
        "POST",
        buildUserInputResponsePath(payload),
        payload,
        options,
      ),
    getTurnDiff: (payload, options) => hostedOperation("turn/diff", options?.signal, (client) => client.getTurnDiff(payload)),
    getArtifact: (artifactId, options) =>
      request.json("GET", buildArtifactPath(artifactId), undefined, options),
    listArtifacts: (payload, options) =>
      request.json("GET", buildListArtifactsPath(payload), undefined, options),
    getWorkspaceManifest: (runId, options) =>
      request.json(
        "GET",
        buildWorkspaceManifestPath(runId),
        undefined,
        options,
      ),
    threadInputCommand: (command, options) =>
      hostedThreadInputOperation(command, options?.signal, (client) => sendThreadInputCommand(client, command)),
  };
}

interface TransportRequest {
  json(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: unknown,
    options?: PlatformClientOperationOptions,
    allowConflictResponse?: boolean,
  ): Promise<unknown>;
}

export interface ThreadInputConflictResponse {
  readonly kind: "thread-input-conflict";
  readonly payload: unknown;
}

export function isThreadInputConflictResponse(
  value: unknown,
): value is ThreadInputConflictResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "thread-input-conflict" &&
    "payload" in value
  );
}

function createTransportRequest(
  options: PlatformHttpTransportOptions,
): TransportRequest {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const credentials = options.credentials ?? "include";
  const previewLimit =
    options.responsePreviewLimit ?? DEFAULT_RESPONSE_PREVIEW_LIMIT;
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return {
    json: (method, path, payload, requestOptions, allowConflictResponse) =>
      sendJsonRequest({
        fetchImpl,
        credentials,
        previewLimit,
        baseUrl,
        method,
        path,
        payload,
        requestOptions,
        headers: options.getHeaders?.(),
        allowConflictResponse,
      }),
  };
}

function sendThreadInputCommand(
  client: ReturnType<typeof createAppServerClient>,
  command: ThreadInputCommand,
): Promise<unknown> {
  switch (command.operation) {
    case "turn.resume":
      return client.resumeTurn(command);
    case "turn.steer":
      return client.steerTurn(command);
    case "thread.input.enqueue":
      return client.enqueueThreadInput(command);
    case "thread.input.list":
      return client.listThreadInputs(command);
    case "thread.input.update":
      return client.updateThreadInput(command);
    case "thread.input.remove":
      return client.removeThreadInput(command);
    case "thread.input.steer":
      return client.steerQueuedThreadInput(command);
    case "thread.input.start":
      return client.startQueuedThreadInput(command);
  }
  const exhaustive: never = command;
  return exhaustive;
}

function threadInputMethod(command: ThreadInputCommand): HostedThreadInputMethod {
  switch (command.operation) {
    case "turn.resume": return "turn/resume";
    case "turn.steer": return "turn/steer";
    case "thread.input.enqueue": return "thread/input/enqueue";
    case "thread.input.list": return "thread/input/list";
    case "thread.input.update": return "thread/input/update";
    case "thread.input.remove": return "thread/input/remove";
    case "thread.input.steer": return "thread/input/steer";
    case "thread.input.start": return "thread/input/start";
  }
  const exhaustive: never = command;
  return exhaustive;
}

function isLargeThreadInputCommand(command: ThreadInputCommand): boolean {
  return command.operation === "turn.steer" ||
    command.operation === "thread.input.enqueue" ||
    command.operation === "thread.input.update";
}

function mapHostedThreadInputError(
  error: unknown,
  responseStatus: number | undefined,
  operation: ThreadInputCommand["operation"],
): Error {
  const transportError = error instanceof AppServerClientError && error.code === "transport"
    ? error.cause
    : error;
  if (responseStatus === 409 && operation !== "thread.input.list") {
    if (transportError instanceof AppServerTransportError && transportError.code === "invalid_response") {
      return new PlatformClientOperationError(
        "INVALID_RESPONSE_FORMAT",
        transportError.message,
        false,
        undefined,
        502,
      );
    }
    return new PlatformClientOperationError(
      "INVALID_ERROR_RESPONSE",
      `Invalid conflict response for ${operation}`,
      false,
      undefined,
      409,
    );
  }
  if (error instanceof AppServerClientError) {
    if (error.code === "server_error" && error.serverError) {
      const serverError = error.serverError;
      const statusCode = serverError.statusCode ?? appServerStatus(serverError.code);
      const operationCode = "operationCode" in serverError && typeof serverError.operationCode === "string"
        ? serverError.operationCode
        : serverError.code;
      return new PlatformClientOperationError(
        parsePlatformOperationErrorCode(operationCode),
        serverError.message,
        "retryable" in serverError && typeof serverError.retryable === "boolean"
          ? serverError.retryable
          : statusCode >= 500 || statusCode === 429,
        "correlationId" in serverError && typeof serverError.correlationId === "string"
          ? serverError.correlationId
          : undefined,
        statusCode,
      );
    }
    if (error.code === "invalid_response") {
      return new PlatformClientOperationError(
        "INVALID_RESPONSE_FORMAT",
        error.message,
        false,
        undefined,
        502,
      );
    }
  }
  if (transportError instanceof AppServerTransportError) {
    if (transportError.code === "aborted") {
      return new PlatformClientOperationError("ABORTED", "Operation aborted", true, undefined, 0);
    }
    if (transportError.code === "invalid_response") {
      const failedResponse = typeof transportError.statusCode === "number" && transportError.statusCode >= 400;
      return new PlatformClientOperationError(
        failedResponse ? "INVALID_ERROR_RESPONSE" : "INVALID_RESPONSE_FORMAT",
        transportError.message,
        false,
        undefined,
        failedResponse ? transportError.statusCode : 502,
      );
    }
    if (transportError.cause instanceof Error && transportError.cause.name === "AbortError") {
      return new PlatformClientOperationError("ABORTED", "Operation aborted", true, undefined, 0);
    }
    if (typeof transportError.statusCode === "number") {
      return new PlatformClientOperationError(
        parsePlatformOperationErrorCode(transportError.serverCode ?? "API_ERROR"),
        transportError.message,
        transportError.statusCode >= 500 || transportError.statusCode === 429,
        undefined,
        transportError.statusCode,
      );
    }
    return new PlatformClientOperationError("NETWORK_ERROR", transportError.message, true, undefined, 0);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new PlatformClientOperationError("ABORTED", "Operation aborted", true, undefined, 0);
  }
  if (error instanceof Error && error.name === "TypeError") {
    return new PlatformClientOperationError("NETWORK_ERROR", error.message, true, undefined, 0);
  }
  return new PlatformClientOperationError(
    "UNKNOWN_OPERATION_ERROR",
    error instanceof Error ? error.message : "Thread input operation failed",
    false,
    undefined,
    500,
  );
}

interface JsonRequestInput {
  fetchImpl: typeof fetch;
  credentials: RequestCredentials;
  previewLimit: number;
  baseUrl: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  payload: unknown;
  requestOptions?: PlatformClientOperationOptions;
  headers?: Record<string, string>;
  allowConflictResponse?: boolean;
}

async function sendJsonRequest(input: JsonRequestInput): Promise<unknown> {
  const response = await sendRequest({
    ...input,
    accept: "application/json",
    contentType: "application/json",
  });
  if (input.allowConflictResponse && response.status === 409) {
    return {
      kind: "thread-input-conflict",
      payload: await parseJsonResponse(
        response,
        input.method,
        input.path,
        input.previewLimit,
      ),
    } satisfies ThreadInputConflictResponse;
  }
  return parseJsonResponse(
    response,
    input.method,
    input.path,
    input.previewLimit,
  );
}

interface RequestInput {
  fetchImpl: typeof fetch;
  credentials: RequestCredentials;
  previewLimit: number;
  baseUrl: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  payload: unknown;
  requestOptions?: PlatformClientOperationOptions;
  accept: string;
  contentType?: string;
  headers?: Record<string, string>;
  allowConflictResponse?: boolean;
}

async function sendRequest(input: RequestInput): Promise<Response> {
  const headers = buildHeaders(input.headers, input.accept, input.contentType);
  const init: RequestInit = {
    method: input.method,
    credentials: input.credentials,
    headers,
    signal: input.requestOptions?.signal,
  };
  if (input.payload !== undefined) {
    init.body = JSON.stringify(input.payload);
  }

  try {
    const response = await input.fetchImpl(
      `${input.baseUrl}${input.path}`,
      init,
    );
    if (
      !response.ok &&
      !(input.allowConflictResponse && response.status === 409)
    ) {
      throw await createOperationErrorFromResponse(
        response,
        input.previewLimit,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof PlatformClientOperationError) {
      throw error;
    }
    throw mapTransportException(error);
  }
}

function buildHeaders(
  inputHeaders: Record<string, string> | undefined,
  accept: string,
  contentType?: string,
): Record<string, string> {
  return {
    Accept: accept,
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...filterProtectedHeaders(inputHeaders),
  };
}

function filterProtectedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!PROTECTED_HEADERS.has(name.toLowerCase())) {
      filtered[name] = value;
    }
  }
  return filtered;
}

async function parseJsonResponse(
  response: Response,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  previewLimit: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const preview = await readResponsePreview(response, previewLimit);
    throw new PlatformClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      `Expected JSON response for ${method} ${path}${formatPreview(preview)}`,
      false,
      undefined,
      502,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new PlatformClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      `Invalid JSON response for ${method} ${path}`,
      false,
      undefined,
      502,
    );
  }
}

async function createOperationErrorFromResponse(
  response: Response,
  previewLimit: number,
): Promise<PlatformClientOperationError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const clone =
      typeof response.clone === "function" ? response.clone() : response;
    try {
      const payload = await response.json();
      const protocolError = parseProtocolErrorEnvelope(payload);
      if (protocolError) {
        return PlatformClientOperationError.fromProtocolError(
          protocolError,
          response.status,
        );
      }
      return createGenericJsonError(payload, response.status);
    } catch {
      const preview = await readResponsePreview(clone, previewLimit);
      return new PlatformClientOperationError(
        "INVALID_ERROR_RESPONSE",
        `Malformed JSON error response${formatPreview(preview)}`,
        false,
        undefined,
        response.status,
      );
    }
  }

  const preview = await readResponsePreview(response, previewLimit);
  return new PlatformClientOperationError(
    "INVALID_ERROR_RESPONSE",
    `Unexpected non-JSON error response${formatPreview(preview)}`,
    false,
    undefined,
    response.status,
  );
}

function createGenericJsonError(
  payload: unknown,
  statusCode: number,
): PlatformClientOperationError {
  const fields = extractErrorFields(payload);
  return new PlatformClientOperationError(
    parsePlatformOperationErrorCode(fields.code ?? "API_ERROR"),
    fields.message ?? `HTTP ${statusCode}`,
    statusCode >= 500 || statusCode === 429,
    fields.correlationId,
    statusCode,
  );
}

function mapHostedLifecycleError(error: unknown, method: HostedLifecycleMethod): HostedOperationError {
  if (error instanceof AppServerClientError) {
    if (error.code === "server_error" && error.serverError) {
      const serverError = error.serverError;
      const statusCode = serverError.statusCode ?? appServerStatus(serverError.code);
      const operationCode = "operationCode" in serverError && typeof serverError.operationCode === "string"
        ? serverError.operationCode
        : serverError.code;
      if (operationCode === "INVALID_RESPONSE_CONTRACT") return hostedResponseContractError(method);
      if (method === "turn/interrupt") {
        return new PlatformClientOperationError(
          "API_ERROR",
          `HTTP ${statusCode}`,
          statusCode >= 500 || statusCode === 429,
          undefined,
          statusCode,
        );
      }
      return mapAppServerError(serverError, statusCode, method);
    }
    if (error.code === "transport") return mapHostedLifecycleError(error.cause, method);
    if (error.code === "invalid_response") return hostedResponseContractError(method);
    return new PlatformClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      error.message,
      false,
      undefined,
      502,
    );
  }

  if (error instanceof AppServerTransportError) {
    if (error.code === "aborted") {
      return new PlatformClientOperationError("ABORTED", "Operation aborted", true, undefined, 0);
    }
    if (error.code === "invalid_response") {
      const failedResponse = typeof error.statusCode === "number" && error.statusCode >= 400;
      return new PlatformClientOperationError(
        failedResponse ? "INVALID_ERROR_RESPONSE" : "INVALID_RESPONSE_FORMAT",
        `${error.message}${error.responsePreview ? `: ${error.responsePreview}` : ""}`,
        false,
        undefined,
        failedResponse ? error.statusCode : 502,
      );
    }
    if (typeof error.statusCode === "number" && error.cause !== undefined) {
      return mapHostedHttpFailure(error.cause, error.statusCode, method);
    }
    if (typeof error.statusCode === "number") {
      return new PlatformClientOperationError(
        "API_ERROR",
        `HTTP ${error.statusCode}`,
        error.statusCode >= 500 || error.statusCode === 429,
        undefined,
        error.statusCode,
      );
    }
    if (error.cause instanceof Error && error.cause.name === "AbortError") {
      return new PlatformClientOperationError("ABORTED", "Operation aborted", true, undefined, 0);
    }
    return new PlatformClientOperationError("NETWORK_ERROR", error.message, true, undefined, 0);
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new PlatformClientOperationError("ABORTED", "Operation aborted", true, undefined, 0);
  }
  if (error instanceof Error && error.name === "TypeError") {
    return new PlatformClientOperationError("NETWORK_ERROR", error.message, true, undefined, 0);
  }
  return new PlatformClientOperationError(
    "UNKNOWN_OPERATION_ERROR",
    error instanceof Error ? error.message : "Hosted lifecycle operation failed",
    false,
    undefined,
    500,
  );
}

function mapHostedHttpFailure(payload: unknown, statusCode: number, method: HostedLifecycleMethod): HostedOperationError {
  const failure = AppServerFailureResponseSchema.safeParse(payload);
  if (failure.success && failure.data.method === method) {
    return mapAppServerError(failure.data.error, statusCode, method);
  }
  if (failure.success || (payload && typeof payload === "object" && "method" in payload && "protocolVersion" in payload)) {
    return new PlatformClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      "App Server returned an invalid response envelope",
      false,
      undefined,
      502,
    );
  }

  const protocolError = parseProtocolErrorEnvelope(payload);
  if (protocolError) {
    return PlatformClientOperationError.fromProtocolError(protocolError, statusCode);
  }

  const appServerError = AppServerErrorSchema.safeParse(payload);
  if (appServerError.success) {
    return mapAppServerError(appServerError.data, statusCode, method);
  }

  return createGenericJsonError(payload, statusCode);
}

function mapAppServerError(
  payload: unknown,
  fallbackStatus: number,
  method: HostedLifecycleMethod,
): HostedOperationError {
  const parsed = AppServerErrorSchema.safeParse(payload);
  if (!parsed.success) return createGenericJsonError(payload, fallbackStatus);
  const error = parsed.data;
  const operationCode = "operationCode" in error && typeof error.operationCode === "string"
    ? error.operationCode
    : error.code;
  if (operationCode === "INVALID_RESPONSE_CONTRACT") return hostedResponseContractError(method);
  return new PlatformClientOperationError(
    parsePlatformOperationErrorCode(operationCode),
    error.message,
    "retryable" in error && typeof error.retryable === "boolean"
      ? error.retryable
      : fallbackStatus >= 500 || fallbackStatus === 429,
    "correlationId" in error && typeof error.correlationId === "string" ? error.correlationId : undefined,
    "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : fallbackStatus,
  );
}

function hostedResponseContractError(method: HostedLifecycleMethod): PlatformClientContractError {
  const operation = method === "turn/interrupt"
    ? "interruptTurn"
    : method === "turn/lifecycleEvents"
      ? "replayLifecycleEvents"
      : method === "turn/diff"
        ? "getTurnDiff"
        : method === "turn/approval"
          ? "submitLifecycleApproval"
          : "compactTurn";
  return new PlatformClientContractError(
    "response",
    operation,
    `Invalid response contract for ${operation}`,
  );
}

function appServerStatus(code: string): number {
  switch (code) {
    case "unauthorized": return 401;
    case "forbidden": return 403;
    case "not_found": return 404;
    case "conflict": return 409;
    case "invalid_request": return 400;
    case "server_unavailable": return 503;
    case "protocol_incompatible": return 409;
    default: return 500;
  }
}

function extractErrorFields(payload: unknown): {
  code?: string;
  message?: string;
  correlationId?: string;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const raw = payload as Record<string, unknown>;
  const nested =
    raw.error && typeof raw.error === "object"
      ? (raw.error as Record<string, unknown>)
      : undefined;
  return {
    code: readStringField(raw, nested, "code"),
    message: readStringField(raw, nested, "message"),
    correlationId: readStringField(raw, nested, "correlationId"),
  };
}

function readStringField(
  raw: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  if (typeof raw[field] === "string") {
    return raw[field];
  }
  if (typeof nested?.[field] === "string") {
    return nested[field];
  }
  return undefined;
}

async function readResponsePreview(
  response: Response,
  limit: number,
): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, limit);
  } catch {
    return "";
  }
}

function mapTransportException(error: unknown): PlatformClientOperationError {
  if (error instanceof Error && error.name === "AbortError") {
    return new PlatformClientOperationError(
      "ABORTED",
      "Request was aborted",
      true,
      undefined,
      0,
    );
  }
  return new PlatformClientOperationError(
    "NETWORK_ERROR",
    error instanceof Error ? error.message : "Network request failed",
    true,
    undefined,
    0,
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new PlatformClientOperationError(
      "INVALID_REQUEST_CONTRACT",
      "baseUrl is required",
      false,
    );
  }
  return trimmed.replace(/\/$/, "");
}

function buildRunEventsPath(runId: string | null): string {
  return `${buildRunPath(RunIdSchema.parse(runId))}/events`;
}

function buildThreadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(ThreadIdSchema.parse(threadId))}`;
}

function buildRunPath(runId: string): string {
  return `/runs/${encodeURIComponent(RunIdSchema.parse(runId))}`;
}

function buildListThreadsPath(request: ListThreadsRequest): string {
  return addListQuery("/threads", {
    userId: request.userId,
    workspaceId: request.workspaceId,
    afterCursor: request.afterCursor ?? undefined,
    limit: request.limit,
  });
}

function buildListArtifactsPath(request: ListArtifactsRequest): string {
  return addListQuery(`${buildRunPath(request.runId)}/artifacts`, {
    afterCursor: request.afterCursor ?? undefined,
    limit: request.limit,
  });
}

function buildReplayRunEventsPath(request: ReplayRunEventsRequest): string {
  const path = buildRunEventsPath(request.runId);
  const params = new URLSearchParams();
  if (request.afterCursor) {
    params.set("afterCursor", request.afterCursor);
  }
  if (request.limit) {
    params.set("limit", String(request.limit));
  }
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

function buildApprovalPath(request: SubmitApprovalRequest): string {
  const runId = encodeURIComponent(RunIdSchema.parse(request.runId));
  const approvalId = encodeURIComponent(request.approvalId);
  return `/runs/${runId}/approvals/${approvalId}`;
}

function buildUserInputResponsePath(
  request: SubmitUserInputResponseRequest,
): string {
  const turnId = encodeURIComponent(TurnIdSchema.parse(request.turnId));
  const requestId = encodeURIComponent(request.requestId);
  return `/turns/${turnId}/user-input/${requestId}`;
}

function buildArtifactPath(artifactId: ArtifactId): string {
  return `/artifacts/${encodeURIComponent(ArtifactIdSchema.parse(artifactId))}`;
}

function buildWorkspaceManifestPath(runId: string): string {
  return `/runs/${encodeURIComponent(RunIdSchema.parse(runId))}/workspace-manifest`;
}

function addListQuery(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      params.set(name, String(value));
    }
  }
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

function formatPreview(preview: string): string {
  return preview.length > 0 ? `; received: ${preview}` : "";
}
