import { createAppServerClient } from "@legioncode/sdk";
import { getBrainHttpBase } from "../../lib/platform-endpoints";

export function initializeHostedAppServer() {
  return createAppServerClient({
    baseUrl: getBrainHttpBase(),
    clientId: "legioncode-web",
    clientVersion: import.meta.env.VITE_GIT_SHA || "0.1.0",
  }).initialize();
}
