import { ApprovalDock } from "@legioncode/client-ui";
import type { AppServerClient, LifecycleProjection } from "@legioncode/sdk";
import type { TurnAdmission } from "@repo/platform-protocol";
import type { ApprovalDecisionKind } from "@repo/shared-types";
import { useState } from "react";
import { useDesktopApprovalDecision } from "./useDesktopApprovalDecision";

interface Props {
  client: AppServerClient;
  admission: TurnAdmission;
  projection: LifecycleProjection;
  canStop: boolean;
  onStop: () => Promise<void>;
  refresh: () => void;
}

export function DesktopApproval({ client, admission, projection, canStop, onStop, refresh }: Props) {
  const command = useDesktopApprovalDecision(client, admission, projection, refresh);
  const [stopError, setStopError] = useState<string | null>(null);
  const approval = projection.pendingApproval;
  if (!approval || projection.terminal) return null;
  const matching = approval.options.find((option) => option.id === "allow_matching_in_chat") ?? null;
  const decisions = approval.options.flatMap((option): ApprovalDecisionKind[] => {
    switch (option.id) {
      case "approve": case "allow_once": return ["allow_once"];
      case "allow_matching_in_chat": return ["allow_persistent_rule"];
      case "deny": return ["deny"];
      case "cancel": case "abort": return ["abort"];
      default: return [];
    }
  });
  const toolName = approval.metadata?.toolName;
  const busyDecision: ApprovalDecisionKind | null = command.delivery
    ? command.delivery.decision === "approved"
      ? command.delivery.grantScope === "matching_in_chat" ? "allow_persistent_rule" : "allow_once"
      : command.delivery.decision === "denied" ? "deny" : "abort"
    : null;

  return <ApprovalDock
    question={approval.question}
    categoryLabel="Local action"
    title={typeof toolName === "string" ? toolName : undefined}
    matchingInChatOption={matching}
    decisions={decisions}
    busyDecision={busyDecision}
    error={command.error ?? stopError ?? (decisions.length === 0 ? "This runtime request has no supported decision option. Stop remains available." : null)}
    onResolve={(decision) => {
      setStopError(null);
      return command.resolve(
        decision === "deny" ? "denied" : decision === "abort" ? "cancelled" : "approved",
        decision === "allow_persistent_rule" ? "matching_in_chat" : undefined,
      );
    }}
    onStop={() => {
      setStopError(null);
      void onStop().catch(() => setStopError("Stop delivery could not be confirmed. Waiting for canonical runtime status."));
    }}
    canStop={canStop}
  />;
}
