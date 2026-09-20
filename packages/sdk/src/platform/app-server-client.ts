import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerErrorSchema,
  AppServerInitializeRequestSchema,
  AppServerInitializeResponseSchema,
  type AppServerInitializeResponse,
} from "@repo/platform-protocol";

export type AppServerClientOptions = {
  baseUrl: string;
  credential?: string;
  clientId: string;
  clientVersion: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class AppServerHandshakeError extends Error {
  constructor(
    public readonly code:
      | "unauthorized"
      | "protocol_incompatible"
      | "invalid_request"
      | "invalid_response"
      | "transport",
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "AppServerHandshakeError";
  }
}

export type AppServerClient = {
  initialize(
    requestedCapabilities?: readonly string[],
  ): Promise<AppServerInitializeResponse>;
};

export function createAppServerClient(
  options: AppServerClientOptions,
): AppServerClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return {
    initialize: async (requestedCapabilities = []) => {
      const request = AppServerInitializeRequestSchema.parse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: {
          id: options.clientId,
          version: options.clientVersion,
        },
        requestedCapabilities: [...requestedCapabilities],
      });

      let response: Response;
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 5_000,
      );
      try {
        response = await fetchImpl(`${baseUrl}/initialize`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(options.credential
              ? { Authorization: `Bearer ${options.credential}` }
              : {}),
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch {
        throw new AppServerHandshakeError(
          "transport",
          "App Server is unreachable",
        );
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }

      const payload = await readJson(response);
      if (!response.ok) {
        const parsedError = AppServerErrorSchema.safeParse(payload);
        throw new AppServerHandshakeError(
          parsedError.success ? parsedError.data.code : "invalid_response",
          parsedError.success
            ? parsedError.data.message
            : `App Server rejected initialize (${response.status})`,
          response.status,
        );
      }

      const parsedResponse = AppServerInitializeResponseSchema.safeParse(payload);
      if (!parsedResponse.success) {
        throw new AppServerHandshakeError(
          "invalid_response",
          "App Server returned an invalid initialize response",
          response.status,
        );
      }
      return parsedResponse.data;
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AppServerHandshakeError(
      "invalid_response",
      "App Server returned invalid JSON",
      response.status,
    );
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
