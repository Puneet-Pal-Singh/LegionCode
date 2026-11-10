import type { LocalPersistence } from "@repo/event-store/local";
import { HarnessSelectionSchema } from "@repo/platform-protocol";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import type { DelegatedHarnessPort } from "@repo/runtime-kernel";
import type { LocalWorkspaceLease } from "./LocalWorkspaceLease.js";

type Session = Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0]["session"];

/** Composition-only ordering over existing authorities. CORE owns physical and
 * journal release; SQLite owns retirement. Neither is inferred from process exit.
 */
export async function settleLocalHarnessAttachment(input: {
  readonly admission: TurnAdmission;
  readonly persistence: LocalPersistence;
  readonly leases: LocalWorkspaceLease;
  readonly releaseAfterCanonicalSettlement: (session: Session) => Promise<void>;
}): Promise<void> {
  const { admission, persistence, leases } = input;
  const terminalEventId = await leases.assertArtifactsCommitted(admission);
  const scope = { userId: admission.run.userId, turnId: admission.turn.id, runAttemptId: admission.runAttemptId };
  const binding = await persistence.harnessBindings.read(scope);
  const proof = await persistence.readAttachmentRetirement(scope);
  if (proof.status === "verified_retirement") {
    // Idempotent retry/restart after a successful (possibly unknown-return-value)
    // retirement. The store validates every generation, ACK, terminal and artifact.
    // Do not require a now-detached in-memory CORE session or call release again.
    await leases.assertSettled(admission);
    return;
  }
  if (binding && !binding.attachment) {
    throw new Error("Local frozen opening or prior retirement requires durable recovery evidence");
  }
  await leases.settleAfterRelease(admission, async () => {
    if (binding?.attachment) {
      const selection = HarnessSelectionSchema.parse(JSON.parse(binding.selection.selectionJson) as unknown);
      const origin = binding.attachment;
      if (selection.runId !== admission.run.id || selection.turnId !== admission.turn.id ||
          selection.threadId !== admission.run.threadId || selection.workspaceId !== admission.run.workspaceId ||
          selection.userId !== admission.run.userId || selection.runAttemptId !== admission.runAttemptId ||
          selection.environmentId !== persistence.environmentId || selection.modelId !== admission.run.modelId ||
          selection.policyId !== admission.run.permissionProfileId ||
          selection.instanceId !== origin.instanceId || selection.authOwnerGeneration !== origin.authOwnerGeneration) {
        throw new Error("Local settlement does not match the frozen attempt and attachment");
      }
      await input.releaseAfterCanonicalSettlement({
        runAttemptId: admission.runAttemptId, instanceId: origin.instanceId,
        externalSessionId: origin.externalSessionId, processGeneration: origin.processGeneration,
      });
      // CORE drained ingress before returning. Read the final committed sequence
      // afterward; a pre-release observation watermark is insufficient for retirement.
      const drained = await persistence.harnessBindings.read(scope);
      if (!drained || drained.selection.selectionJson !== binding.selection.selectionJson ||
          drained.attachment?.instanceId !== origin.instanceId ||
          drained.attachment.externalSessionId !== origin.externalSessionId ||
          drained.attachment.processGeneration !== origin.processGeneration ||
          drained.attachment.authOwnerGeneration !== origin.authOwnerGeneration ||
          drained.lastObservationSequence < binding.lastObservationSequence) {
        throw new Error("Local attachment changed during canonical CORE release");
      }
      // If this commit fails/has unknown outcome, the caller retains its active
      // owner. A missing live CORE session on retry is never success; restart must
      // use existing journal settlement evidence or remain recovery_required.
      await persistence.retireHarnessAttachment({
        selection: drained.selection, origin,
        lastObservationSequence: drained.lastObservationSequence, terminalEventId,
      });
    }
  });
}
