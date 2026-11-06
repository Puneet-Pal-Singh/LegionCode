import { createHostedAppServerClient } from "./appServerClient";

type ListParams = Parameters<ReturnType<typeof createHostedAppServerClient>["listCheckoutFiles"]>[0];
type ReadParams = Parameters<ReturnType<typeof createHostedAppServerClient>["readCheckoutFile"]>[0];
export type CheckoutTurnIdentity = Pick<ReadParams, "turnId" | "runAttemptId">;

export function listCheckoutFiles(params: ListParams, signal: AbortSignal) {
  return createHostedAppServerClient({ signal }).listCheckoutFiles(params);
}
export function readCheckoutFile(params: ReadParams, signal: AbortSignal) {
  return createHostedAppServerClient({ signal }).readCheckoutFile(params);
}
