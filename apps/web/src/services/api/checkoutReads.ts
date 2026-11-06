import { RunIdSchema } from "@legioncode/sdk";
import { createHostedAppServerClient } from "./appServerClient";

export function listCheckoutFiles(sessionId: string, runId: string, path: string, signal: AbortSignal) {
  return createHostedAppServerClient({ signal }).listCheckoutFiles({ sessionId, runId: RunIdSchema.parse(runId), path });
}

export function readCheckoutFile(sessionId: string, runId: string, path: string, signal: AbortSignal) {
  return createHostedAppServerClient({ signal }).readCheckoutFile({ sessionId, runId: RunIdSchema.parse(runId), path });
}
