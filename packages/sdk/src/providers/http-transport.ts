import { resolveCanonicalRunId, createOperationErrorFromResponse } from "./transport-support.js";
import type {
  ProviderClientOperationOptions,
  ProviderClientTransport,
} from "./client.js";
import {
  ProviderClientOperationError,
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
