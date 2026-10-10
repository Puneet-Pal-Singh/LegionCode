import {
  createAppServerClient,
  createAppServerHttpTransport,
  type AppServerHttpTransportOptions,
} from "@legioncode/sdk";
import { getBrainHttpBase } from "../../lib/platform-endpoints";

export function initializeHostedAppServer() {
  return createHostedAppServerClient().initialize();
}

/** Cookie authorization and cancellation are host transport bindings. */
export function createHostedAppServerClient(
  options: Pick<AppServerHttpTransportOptions, "signal" | "timeoutMs" | "maxResponseBytes"> = {},
) {
  return createAppServerClient({
    clientId: "legioncode-web",
    clientVersion: import.meta.env.VITE_GIT_SHA || "0.1.0",
    transport: createAppServerHttpTransport({
      baseUrl: getBrainHttpBase(), credentials: "include", ...options,
    }),
  });
}
