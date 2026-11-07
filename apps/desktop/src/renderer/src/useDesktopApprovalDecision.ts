import type { AppServerClient, LifecycleProjection } from "@legioncode/sdk";
import type { SubmitLifecycleApprovalRequest, TurnAdmission } from "@repo/platform-protocol";
import { useEffect, useRef, useState } from "react";

type Decision = SubmitLifecycleApprovalRequest["decision"];
type GrantScope = SubmitLifecycleApprovalRequest["grantScope"];

/** Only command delivery is local state; canonical replay closes the request. */
export function useDesktopApprovalDecision(
  client: AppServerClient,
  admission: TurnAdmission,
  projection: LifecycleProjection,
  refresh: () => void,
) {
  const approval = projection.pendingApproval;
  const [delivery, setDelivery] = useState<{ decision: Decision; grantScope?: GrantScope } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const request = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    request.current = null;
    setDelivery(null);
    setError(null);
    return () => controller.abort();
  }, [client, admission.turn.id, admission.runAttemptId, approval?.approvalId]);

  async function resolve(decision: Decision, grantScope?: GrantScope): Promise<void> {
    const controller = active.current;
    if (!controller || controller.signal.aborted || !approval || projection.terminal || projection.turnId !== admission.turn.id) return;
    if (request.current) return request.current;
    const optionId = decision === "approved"
      ? grantScope === "matching_in_chat" ? "allow_matching_in_chat" : "approve"
      : decision === "denied" ? "deny" : "cancel";
    if (!approval.options.some((option) => option.id === optionId || (decision === "cancelled" && option.id === "abort"))) {
      setError("This decision is not offered by the current runtime request.");
      return;
    }
    setDelivery({ decision, grantScope });
    setError(null);
    const pending = client.submitLifecycleApproval({
      turnId: admission.turn.id, approvalId: approval.approvalId,
      decision, ...(grantScope ? { grantScope } : {}),
      decidedBy: admission.run.userId, reason: null,
    }).then((receipt) => {
      if (controller.signal.aborted || active.current !== controller) return;
      if (receipt.type !== "approval.decided" || receipt.approvalId !== approval.approvalId ||
        receipt.turnId !== admission.turn.id || receipt.threadId !== admission.turn.threadId ||
        receipt.runAttemptId !== admission.runAttemptId || receipt.payload.status !== decision ||
        (grantScope === "matching_in_chat" && receipt.payload.grantScope !== grantScope)) {
        throw new Error("Approval receipt does not match the admitted request");
      }
      refresh();
      // Keep the controls locked until replay removes this exact pending approval.
    }).catch(() => {
      if (controller.signal.aborted || active.current !== controller) return;
      request.current = null;
      setDelivery(null);
      setError("Approval delivery could not be confirmed. The recorded runtime decision remains authoritative; retry or read its status.");
      refresh();
    });
    request.current = pending;
    return pending;
  }

  return { delivery, error, resolve };
}
