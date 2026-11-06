import {
  createAppServerClient,
  createAppServerHttpTransport,
  GitMutationError,
  type AppServerHttpTransportOptions,
} from "@legioncode/sdk";
import { getBrainHttpBase } from "../../lib/platform-endpoints";

export function isGitMutationError(error: unknown): error is GitMutationError {
  return error instanceof GitMutationError;
}

export function initializeHostedAppServer() {
  return createHostedAppServerClient().initialize();
}

/** Cookie authorization and cancellation are host transport bindings. */
export function createHostedAppServerClient(
  options: Pick<AppServerHttpTransportOptions, "signal" | "timeoutMs" | "maxResponseBytes" | "requestHeaders"> = {},
) {
  return createAppServerClient({
    clientId: "legioncode-web",
    clientVersion: import.meta.env.VITE_GIT_SHA || "0.1.0",
    transport: createAppServerHttpTransport({
      baseUrl: getBrainHttpBase(), credentials: "include", ...options,
    }),
  });
}
