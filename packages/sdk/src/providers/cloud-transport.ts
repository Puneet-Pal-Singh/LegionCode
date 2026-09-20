import type { ProviderClientTransport } from "./client.js";
import {
  createByokHttpTransport,
  type ProviderHttpTransportOptions,
} from "./http-transport.js";

const CLOUD_DEFAULT_CREDENTIALS: RequestCredentials = "omit";

export interface ProviderCloudTransportOptions
  extends Omit<ProviderHttpTransportOptions, "credentials" | "getHeaders"> {
  getAccessToken?: () => string | null;
  getHeaders?: () => Record<string, string>;
}

export function createByokCloudTransport(
  options: ProviderCloudTransportOptions,
): ProviderClientTransport {
  return createByokHttpTransport({
    baseUrl: options.baseUrl,
    getRunId: options.getRunId,
    fetchImpl: options.fetchImpl,
    responsePreviewLimit: options.responsePreviewLimit,
    credentials: CLOUD_DEFAULT_CREDENTIALS,
    getHeaders: () => createCloudHeaders(options),
  });
}

function createCloudHeaders(
  options: ProviderCloudTransportOptions,
): Record<string, string> {
  const headers = options.getHeaders?.() ?? {};
  if (hasAuthorizationHeader(headers)) {
    return headers;
  }
  const accessToken = options.getAccessToken?.();
  if (!accessToken) {
    return headers;
  }
  return {
    ...headers,
    Authorization: `Bearer ${accessToken}`,
  };
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(
    (headerName) => headerName.toLowerCase() === "authorization",
  );
}
