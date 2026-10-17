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
  parsePlatformOperationErrorCode,
  parseProtocolErrorEnvelope,
} from "./errors.js";
import type {
  GetTurnDiffRequest,
  CompactTurnRequest,
  ReplayLifecycleEventsRequest,
  SubmitLifecycleApprovalRequest,
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

  return {
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
    replayLifecycleEvents: (payload, options) =>
      request.json(
        "GET",
        buildReplayLifecycleEventsPath(payload),
        undefined,
        options,
      ),
    interruptTurn: (payload, options) =>
      request.json("POST", buildInterruptTurnPath(), payload, options),
    compactTurn: (payload, options) =>
      request.json("POST", buildCompactTurnPath(payload), payload, options),
    submitApproval: (payload, options) =>
      request.json("POST", buildApprovalPath(payload), payload, options),
    submitLifecycleApproval: (payload, options) =>
      request.json(
        "POST",
        buildLifecycleApprovalPath(payload),
        payload,
        options,
      ),
    submitUserInputResponse: (payload, options) =>
      request.json(
        "POST",
        buildUserInputResponsePath(payload),
        payload,
        options,
      ),
    getTurnDiff: (payload, options) =>
      request.json("GET", buildTurnDiffPath(payload), undefined, options),
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
      sendThreadInputCommand(request, command, options),
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
  request: TransportRequest,
  command: ThreadInputCommand,
  options?: PlatformClientOperationOptions,
): Promise<unknown> {
  switch (command.operation) {
    case "turn.resume":
      return request.json("POST", "/turn/resume", command, options, true);
    case "turn.steer":
      return request.json("POST", "/turn/steer", command, options, true);
    case "thread.input.enqueue":
      return request.json("POST", "/thread/inputs", command, options, true);
    case "thread.input.list":
      return request.json(
        "GET",
        buildListThreadInputsPath(command),
        undefined,
        options,
      );
    case "thread.input.update":
      return request.json(
        "PATCH",
        buildThreadInputPath(command.itemId),
        command,
        options,
        true,
      );
    case "thread.input.remove":
      return request.json(
        "DELETE",
        buildThreadInputPath(command.itemId),
        command,
        options,
        true,
      );
    case "thread.input.steer":
      return request.json(
        "POST",
        `${buildThreadInputPath(command.itemId)}/steer`,
        command,
        options,
        true,
      );
    case "thread.input.start":
      return request.json(
        "POST",
        `${buildThreadInputPath(command.itemId)}/start`,
        command,
        options,
        true,
      );
  }
  const exhaustive: never = command;
  return exhaustive;
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

function buildLifecycleEventsPath(turnId: string): string {
  return `/turns/${encodeURIComponent(TurnIdSchema.parse(turnId))}/lifecycle-events`;
}

function buildThreadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(ThreadIdSchema.parse(threadId))}`;
}

function buildThreadInputPath(itemId: string): string {
  return `/thread/inputs/${encodeURIComponent(itemId)}`;
}

function buildListThreadInputsPath(
  request: Extract<ThreadInputCommand, { operation: "thread.input.list" }>,
): string {
  const params = new URLSearchParams({
    threadId: request.threadId,
    workspaceId: request.workspaceId,
  });
  if (request.knownRevision !== undefined) {
    params.set("knownRevision", String(request.knownRevision));
  }
  return `/thread/inputs?${params.toString()}`;
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

function buildReplayLifecycleEventsPath(
  request: ReplayLifecycleEventsRequest,
): string {
  const path = buildLifecycleEventsPath(request.turnId);
  return addLifecycleReplayQuery(
    path,
    request.afterSequence ?? null,
    request.limit,
  );
}

function buildApprovalPath(request: SubmitApprovalRequest): string {
  const runId = encodeURIComponent(RunIdSchema.parse(request.runId));
  const approvalId = encodeURIComponent(request.approvalId);
  return `/runs/${runId}/approvals/${approvalId}`;
}

function buildLifecycleApprovalPath(
  request: SubmitLifecycleApprovalRequest,
): string {
  const turnId = encodeURIComponent(TurnIdSchema.parse(request.turnId));
  const approvalId = encodeURIComponent(request.approvalId);
  return `/turns/${turnId}/approvals/${approvalId}`;
}

function buildUserInputResponsePath(
  request: SubmitUserInputResponseRequest,
): string {
  const turnId = encodeURIComponent(TurnIdSchema.parse(request.turnId));
  const requestId = encodeURIComponent(request.requestId);
  return `/turns/${turnId}/user-input/${requestId}`;
}

function buildTurnDiffPath(request: GetTurnDiffRequest): string {
  return `/turns/${encodeURIComponent(TurnIdSchema.parse(request.turnId))}/diff`;
}

function buildInterruptTurnPath(): string {
  return "/api/run/interrupt";
}

function buildCompactTurnPath(request: CompactTurnRequest): string {
  return `/turns/${encodeURIComponent(TurnIdSchema.parse(request.turnId))}/compact`;
}

function buildArtifactPath(artifactId: ArtifactId): string {
  return `/artifacts/${encodeURIComponent(ArtifactIdSchema.parse(artifactId))}`;
}

function buildWorkspaceManifestPath(runId: string): string {
  return `/runs/${encodeURIComponent(RunIdSchema.parse(runId))}/workspace-manifest`;
}

function addLifecycleReplayQuery(
  path: string,
  afterSequence: number | null,
  limit: number | undefined,
): string {
  const params = new URLSearchParams();
  if (afterSequence !== null) {
    params.set("afterSequence", String(afterSequence));
  }
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
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
