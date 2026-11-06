import { createHostedAppServerClient } from "./appServerClient";

type ReadParams = Parameters<ReturnType<typeof createHostedAppServerClient>["readCheckoutFile"]>[0];
export type CheckoutTurnIdentity = Pick<ReadParams, "turnId" | "runAttemptId">;

export function listCheckoutFiles(params: ReadParams, signal: AbortSignal) {
  return createHostedAppServerClient({ signal }).listCheckoutFiles(params);
}
export function readCheckoutFile(params: ReadParams, signal: AbortSignal) {
  return createHostedAppServerClient({ signal }).readCheckoutFile(params);
}
