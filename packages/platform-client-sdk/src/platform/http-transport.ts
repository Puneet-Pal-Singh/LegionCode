import {
  ArtifactIdSchema,
  RunIdSchema,
  type ArtifactId,
} from "@repo/platform-protocol";
import {
  PlatformClientOperationError,
  parsePlatformOperationErrorCode,
  parseProtocolErrorEnvelope,
} from "./errors.js";
import type {
  AttachRunStreamRequest,
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
    appendRunEvent: (payload, options) =>
      request.json("POST", buildRunEventsPath(payload.runId), payload, options),
    attachRunStream: (payload, options) =>
      request.stream(buildRunEventsStreamPath(payload), options),
    replayRunEvents: (payload, options) =>
      request.json("GET", buildReplayRunEventsPath(payload), undefined, options),
    submitApproval: (payload, options) =>
      request.json("POST", buildApprovalPath(payload), payload, options),
    getArtifact: (artifactId, options) =>
      request.json("GET", buildArtifactPath(artifactId), undefined, options),
    getWorkspaceManifest: (runId, options) =>
      request.json(
        "GET",
        buildWorkspaceManifestPath(runId),
        undefined,
        options,
      ),
  };
}

interface TransportRequest {
  json(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    options?: PlatformClientOperationOptions,
  ): Promise<unknown>;
  stream(
    path: string,
    options?: PlatformClientOperationOptions,
  ): AsyncIterable<unknown>;
}

function createTransportRequest(
  options: PlatformHttpTransportOptions,
): TransportRequest {
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = options.credentials ?? "include";
  const previewLimit =
    options.responsePreviewLimit ?? DEFAULT_RESPONSE_PREVIEW_LIMIT;
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return {
    json: (method, path, payload, requestOptions) =>
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
      }),
    stream: (path, requestOptions) =>
      streamJsonLines({
        fetchImpl,
        credentials,
        previewLimit,
        baseUrl,
        path,
        requestOptions,
        headers: options.getHeaders?.(),
      }),
  };
}

interface JsonRequestInput {
  fetchImpl: typeof fetch;
  credentials: RequestCredentials;
  previewLimit: number;
  baseUrl: string;
  method: "GET" | "POST";
  path: string;
  payload: unknown;
  requestOptions?: PlatformClientOperationOptions;
  headers?: Record<string, string>;
}

async function sendJsonRequest(input: JsonRequestInput): Promise<unknown> {
  const response = await sendRequest({
    ...input,
    accept: "application/json",
    contentType: "application/json",
  });
  return parseJsonResponse(response, input.method, input.path, input.previewLimit);
}

interface StreamRequestInput {
  fetchImpl: typeof fetch;
  credentials: RequestCredentials;
  previewLimit: number;
  baseUrl: string;
  path: string;
  requestOptions?: PlatformClientOperationOptions;
  headers?: Record<string, string>;
}

async function* streamJsonLines(input: StreamRequestInput): AsyncIterable<unknown> {
  const response = await sendRequest({
    ...input,
    method: "GET",
    payload: undefined,
    accept: "application/x-ndjson",
  });
  if (!response.body) {
    throw new PlatformClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      `Missing stream body for GET ${input.path}`,
      false,
      undefined,
      502,
    );
  }

  for await (const line of readNonEmptyLines(response.body)) {
    yield parseJsonLine(line, input.path);
  }
}

interface RequestInput extends StreamRequestInput {
  method: "GET" | "POST";
  payload: unknown;
  accept: string;
  contentType?: string;
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
    const response = await input.fetchImpl(`${input.baseUrl}${input.path}`, init);
    if (!response.ok) {
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
  method: "GET" | "POST",
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
    const clone = typeof response.clone === "function" ? response.clone() : response;
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
  const nested = raw.error && typeof raw.error === "object"
    ? raw.error as Record<string, unknown>
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

async function* readNonEmptyLines(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          yield trimmed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  const trimmed = buffer.trim();
  if (trimmed.length > 0) {
    yield trimmed;
  }
}

function parseJsonLine(line: string, path: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new PlatformClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      `Invalid JSON stream line for GET ${path}`,
      false,
      undefined,
      502,
    );
  }
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
  return `/runs/${encodeURIComponent(RunIdSchema.parse(runId))}/events`;
}

function buildRunEventsStreamPath(request: AttachRunStreamRequest): string {
  const path = `${buildRunEventsPath(request.runId)}/stream`;
  return addCursorQuery(path, request.afterCursor ?? null);
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

function buildArtifactPath(artifactId: ArtifactId): string {
  return `/artifacts/${encodeURIComponent(ArtifactIdSchema.parse(artifactId))}`;
}

function buildWorkspaceManifestPath(runId: string): string {
  return `/runs/${encodeURIComponent(RunIdSchema.parse(runId))}/workspace-manifest`;
}

function addCursorQuery(path: string, cursor: string | null): string {
  if (!cursor) {
    return path;
  }
  return `${path}?afterCursor=${encodeURIComponent(cursor)}`;
}

function formatPreview(preview: string): string {
  return preview.length > 0 ? `; received: ${preview}` : "";
}
