import type { AppServerRequest, AppServerTransport } from "./app-server-client.js";
import {
  AppServerErrorSchema,
  AppServerFailureResponseSchema,
} from "@legioncode/app-server/protocol";

export type AppServerHttpTransportOptions = {
  baseUrl: string;
  credential?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number | null;
  /** Null preserves an operation's existing uncapped response-body contract. */
  maxResponseBytes?: number | null;
  /** Keeps malformed response diagnostics within the caller's established bound. */
  responsePreviewLimit?: number;
  credentials?: RequestCredentials;
  signal?: AbortSignal;
  requestHeaders?: (
    envelope: AppServerRequest,
  ) => Record<string, string> | Promise<Record<string, string>>;
};

const MAX_RESPONSE_BYTES = 1_048_576;

export class AppServerTransportError extends Error {
  constructor(
    public readonly code: "transport" | "timeout" | "aborted" | "server_error" | "invalid_response",
    message: string,
    public readonly statusCode?: number,
    public readonly serverCode?: string,
    public readonly cause?: unknown,
    public readonly responsePreview?: string,
  ) {
    super(message);
    this.name = "AppServerTransportError";
  }
}

export function createAppServerHttpTransport(
  options: AppServerHttpTransportOptions,
): AppServerTransport {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    request: async (envelope: AppServerRequest): Promise<unknown> => {
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) controller.abort();
      const timeout = options.timeoutMs === null ? null : setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 5_000);

      try {
        const suppliedHeaders = await options.requestHeaders?.(envelope);
        const headers = new Headers();
        for (const [name, value] of Object.entries(suppliedHeaders ?? {})) {
          const normalizedName = name.toLowerCase();
          if (normalizedName === "accept" || normalizedName === "content-type" || normalizedName === "authorization") continue;
          headers.set(name, value);
        }
        headers.set("Accept", "application/json");
        headers.set("Content-Type", "application/json");
        if (options.credential) headers.set("Authorization", `Bearer ${options.credential}`);
        const response = await fetchImpl(`${baseUrl}/app-server/request`, {
          method: "POST",
          headers,
          body: JSON.stringify(envelope),
          redirect: "error",
          credentials: options.credentials,
          signal: controller.signal,
        });
        const result = await readBoundedJson(
          response,
          options.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : options.maxResponseBytes,
          options.responsePreviewLimit ?? 120,
        );
        if (result === undefined) {
          throw new AppServerTransportError(
            "invalid_response",
            "App Server returned invalid JSON",
            response.status,
          );
        }
        const { payload, preview } = result;
        const isJson = response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
        if (!response.ok && !isJson && isHostedLifecycleMethod(envelope.method)) {
          throw new AppServerTransportError(
            "invalid_response",
            "Unexpected non-JSON error response",
            response.status,
            undefined,
            undefined,
            preview,
          );
        }
        if (payload === undefined) {
          throw new AppServerTransportError(
            "invalid_response",
            response.headers.get("content-type")?.toLowerCase().includes("application/json")
              ? "Malformed JSON error response"
              : "Unexpected non-JSON error response",
            response.status,
            undefined,
            undefined,
            preview,
          );
        }
        if (!response.ok) {
          const failure = AppServerFailureResponseSchema.safeParse(payload);
          if (
            failure.success &&
            failure.data.protocolVersion === envelope.protocolVersion &&
            failure.data.method === envelope.method
          ) {
            return payload;
          }
          const genericError = AppServerErrorSchema.safeParse(payload);
          if (genericError.success) {
            throw new AppServerTransportError(
              "server_error",
              genericError.data.message,
              response.status,
              genericError.data.code,
              payload,
            );
          }
          throw new AppServerTransportError(
            "transport",
            "App Server request failed",
            response.status,
            undefined,
            payload,
          );
        }
        return payload;
      } catch (error) {
        if (error instanceof AppServerTransportError) throw error;
        if (timedOut) {
          throw new AppServerTransportError("timeout", "App Server request timed out");
        }
        if (options.signal?.aborted) {
          throw new AppServerTransportError("aborted", "App Server request was aborted");
        }
        throw new AppServerTransportError("transport", "App Server is unreachable", undefined, undefined, error);
      } finally {
        if (timeout !== null) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

function isHostedLifecycleMethod(method: AppServerRequest["method"]): boolean {
  return method === "turn/lifecycleEvents" || method === "turn/diff" ||
    method === "turn/approval" || method === "turn/compact";
}

async function readBoundedJson(
  response: Response,
  maxResponseBytes: number | null,
  responsePreviewLimit: number,
): Promise<{ payload: unknown | undefined; preview: string } | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (maxResponseBytes !== null && declaredLength && Number(declaredLength) > maxResponseBytes) {
    await response.body?.cancel();
    throw new AppServerTransportError("transport", "App Server response is too large", response.status);
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (maxResponseBytes !== null && totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new AppServerTransportError("transport", "App Server response is too large", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder().decode(bytes);
    const preview = text.trim().slice(0, responsePreviewLimit);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return { payload: undefined, preview };
    }
    return { payload, preview };
  } catch {
    return { payload: undefined, preview: "" };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError("App Server base URL must be an absolute HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("App Server base URL must be an absolute HTTP URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}
