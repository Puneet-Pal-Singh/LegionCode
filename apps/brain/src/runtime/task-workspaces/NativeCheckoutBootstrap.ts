import { NativeCheckoutBootstrapIntentSchema, type NativeCheckoutBootstrapIntent } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import type { WorkspaceSnapshot } from "@repo/platform-protocol";
import { ExecutionService } from "../../services/ExecutionService";
import type { SecureExecutionSessionPort } from "../../services/secure-execution/SecureExecutionSessionClient";
import type { SecureExecutionWorkspaceScope } from "../RuntimeWorkspaceScope";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import type { Env } from "../../types/ai";

export function nativeCheckoutBootstrapIntent(snapshot: WorkspaceSnapshot, checkoutId: string, root: string): NativeCheckoutBootstrapIntent {
  return Object.freeze(NativeCheckoutBootstrapIntentSchema.parse({ version: 1, checkoutId, snapshotId: snapshot.snapshotId,
    repositoryUrl: snapshot.repository.canonicalUrl, authorizedCommitId: snapshot.authorizedCommitId,
    authorizedTreeId: snapshot.authorizedTreeId, workingBranch: `task/${checkoutId}`, root }));
}
/** The same acquired port is lent to canonical Git auth, never acquired from
 * inside its own creation promise. Materialization alone cannot issue Ready. */
export async function bootstrapNativeCheckoutBeforeReady(env: Env, payload: ExecuteRunPayload,
  workspaceScope: SecureExecutionWorkspaceScope, session: SecureExecutionSessionPort, intent: NativeCheckoutBootstrapIntent): Promise<void> {
  if (!session.bootstrapNativeCheckout || !session.verifyNativeCheckoutReady) throw new Error("NATIVE_BOOTSTRAP_OWNER_REQUIRED");
  await new ExecutionService(env, payload.sessionId, payload.runId, payload.userId, workspaceScope, session).bootstrapNativeCheckout();
  await session.verifyNativeCheckoutReady(intent);
}
