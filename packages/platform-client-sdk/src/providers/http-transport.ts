import type {
  ProviderClientOperationOptions,
  ProviderClientTransport,
} from "./client.js";
import { RunIdSchema, type RunId } from "@repo/platform-protocol";
import {
  ProviderClientOperationError,
  isRetryableProviderClientErrorCode,
  parseProviderErrorEnvelope,
  parseProviderOperationErrorCode,
} from "./errors.js";
import type {
  BYOKCredentialConnectRequest,
  BYOKCredentialUpdateRequest,
  BYOKCredentialValidateRequest,
  BYOKPreferencesUpdateRequest,
  BYOKResolveRequest,
} from "./types.js";

const DEFAULT_RESPONSE_PREVIEW_LIMIT = 120;
const TRANSPORT_PROTECTED_HEADERS = new Set(["content-type", "x-run-id"]);

export interface ProviderHttpTransportOptions {
  baseUrl: string;
  getRunId: () => string | null;
  getHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  credentials?: RequestCredentials;
  responsePreviewLimit?: number;
}

export function createByokHttpTransport(
  options: ProviderHttpTransportOptions,
): ProviderClientTransport {
  const request = createTransportRequest(options);

  return {
    discoverProviders: (options) => request("GET", "/providers", undefined, options),
    discoverProviderModels: (providerId, query, options) =>
      request("GET", buildProviderModelsPath(providerId, query), undefined, options),
    refreshProviderModels: (providerId, options) =>
      request(
        "POST",
        `/providers/${encodeURIComponent(providerId)}/models/refresh`,
        {},
        options,
      ),
    listCredentials: (options) => request("GET", "/credentials", undefined, options),
    connectCredential: (payload: BYOKCredentialConnectRequest, options) =>
      request("POST", "/credentials", payload, options),
    updateCredential: (
      credentialId: string,
      payload: BYOKCredentialUpdateRequest,
      options,
    ) => request("PATCH", `/credentials/${encodeURIComponent(credentialId)}`, payload, options),
    disconnectCredential: async (credentialId: string, options) => {
      await request("DELETE", `/credentials/${encodeURIComponent(credentialId)}`, undefined, options);
    },
    validateCredential: (
      credentialId: string,
      payload: BYOKCredentialValidateRequest,
      options,
    ) =>
      request(
        "POST",
        `/credentials/${encodeURIComponent(credentialId)}/validate`,
        payload,
        options,
      ),
    getPreferences: (options) => request("GET", "/preferences", undefined, options),
    updatePreferences: (payload: BYOKPreferencesUpdateRequest, options) =>
      request("PATCH", "/preferences", payload, options),
    resolveForRun: (payload: BYOKResolveRequest, options) =>
      request("POST", "/resolve", payload, options),
  };
}

type TransportRequest = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: unknown,
  requestOptions?: ProviderClientOperationOptions,
) => Promise<unknown>;

function createTransportRequest(
  options: ProviderHttpTransportOptions,
): TransportRequest {
  const credentials = options.credentials ?? "include";
  const responsePreviewLimit =
    options.responsePreviewLimit ?? DEFAULT_RESPONSE_PREVIEW_LIMIT;
  const normalizedBaseUrl = options.baseUrl.replace(/\/$/, "");

  return async (method, path, payload, requestOptions) => {
    const runId = resolveCanonicalRunId(options.getRunId);

    const url = `${normalizedBaseUrl}${path}`;
    const additionalHeaders = filterProtectedHeaders(options.getHeaders?.());
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Run-Id": runId,
      ...additionalHeaders,
    };
    const requestInit: RequestInit = {
      method,
      credentials,
      headers,
      signal: requestOptions?.signal,
    };

    if (payload !== undefined) {
      requestInit.body = JSON.stringify(payload);
    }

    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(url, requestInit);
      if (!response.ok) {
        throw await createOperationErrorFromResponse(response, responsePreviewLimit);
      }
      return parseSuccessResponse(response, method, path, responsePreviewLimit);
    } catch (error) {
      if (error instanceof ProviderClientOperationError) {
        throw error;
      }
      throw mapTransportException(error);
    }
  };
}

function resolveCanonicalRunId(getRunId: () => string | null): RunId {
  const runId = getRunId();
  if (!runId) {
    throw new ProviderClientOperationError(
      "MISSING_RUN_ID",
      "Run ID is required for provider requests",
      false,
      undefined,
      400,
    );
  }

  const parsed = RunIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new ProviderClientOperationError(
      "INVALID_REQUEST_CONTRACT",
      "Provider requests require a canonical run ID",
      false,
      undefined,
      400,
    );
  }
  return parsed.data;
}

function filterProtectedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const filteredHeaders: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(headers)) {
    if (TRANSPORT_PROTECTED_HEADERS.has(headerName.toLowerCase())) {
      continue;
    }
    filteredHeaders[headerName] = value;
  }
  return filteredHeaders;
}

function buildProviderModelsPath(providerId: string, query: unknown): string {
  const raw = isModelsQuery(query) ? query : {};
  const params = new URLSearchParams({
    view: raw.view ?? "popular",
    limit: String(raw.limit ?? 50),
  });
  if (raw.cursor) {
    params.set("cursor", raw.cursor);
  }
  return `/providers/${encodeURIComponent(providerId)}/models?${params.toString()}`;
}

function isModelsQuery(
  value: unknown,
): value is { view?: string; limit?: number; cursor?: string } {
  return !!value && typeof value === "object";
}

async function parseSuccessResponse(
  response: Response,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  responsePreviewLimit: number,
): Promise<unknown> {
  if (response.status === 204 || method === "DELETE") {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const preview = await readResponsePreview(response, responsePreviewLimit);
    throw new ProviderClientOperationError(
      "INVALID_RESPONSE_FORMAT",
      `Expected JSON response for ${method} ${path}${preview ? `; received: ${preview}` : ""}`,
      false,
      undefined,
      502,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderClientOperationError(
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
  responsePreviewLimit: number,
): Promise<ProviderClientOperationError> {
  let code = "API_ERROR";
  let message = `HTTP ${response.status}`;
  let correlationId: string | undefined;
  let retryable = response.status >= 500 || response.status === 429;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const previewResponse =
      typeof response.clone === "function" ? response.clone() : response;
    try {
      const payload = await response.json();
      const envelope = parseProviderErrorEnvelope(payload);
      if (envelope) {
        return new ProviderClientOperationError(
          envelope.error.code,
          envelope.error.message,
          envelope.error.retryable ||
            isRetryableProviderClientErrorCode(envelope.error.code),
          envelope.error.correlationId,
          response.status,
        );
      }

      const fallback = extractErrorFields(payload);
      code = fallback.code ?? code;
      message = fallback.message ?? message;
      correlationId = fallback.correlationId;
      retryable =
        retryable ||
        isRetryableProviderClientErrorCode(parseProviderOperationErrorCode(code));
    } catch (error) {
      const preview = await readResponsePreview(previewResponse, responsePreviewLimit);
      code = "INVALID_ERROR_RESPONSE";
      message = preview
        ? `Malformed JSON error response: ${preview}`
        : "Malformed JSON error response";
      retryable = false;
      console.warn(
        "[provider/httpTransport] Failed to parse JSON error response",
        { error },
      );
    }
  } else {
    const preview = await readResponsePreview(response, responsePreviewLimit);
    if (preview.length > 0) {
      code = "INVALID_ERROR_RESPONSE";
      message = `Unexpected non-JSON error response: ${preview}`;
    }
  }

  return new ProviderClientOperationError(
    parseProviderOperationErrorCode(code),
    message,
    retryable,
    correlationId,
    response.status,
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
  const nestedError =
    raw.error && typeof raw.error === "object"
      ? (raw.error as Record<string, unknown>)
      : undefined;

  const message =
    typeof raw.error === "string"
      ? raw.error
      : typeof raw.message === "string"
        ? raw.message
        : typeof nestedError?.message === "string"
          ? nestedError.message
          : undefined;

  const code =
    typeof raw.code === "string"
      ? raw.code
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : undefined;

  const correlationId =
    typeof raw.correlationId === "string"
      ? raw.correlationId
      : typeof nestedError?.correlationId === "string"
        ? nestedError.correlationId
        : undefined;

  return { code, message, correlationId };
}

async function readResponsePreview(
  response: Response,
  limit: number,
): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

function mapTransportException(error: unknown): ProviderClientOperationError {
  if (isAbortError(error)) {
    return new ProviderClientOperationError("ABORTED", "Request was aborted", true, undefined, 0);
  }
  return new ProviderClientOperationError(
    "NETWORK_ERROR",
    error instanceof Error ? error.message : "Network request failed",
    true,
    undefined,
    0,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
