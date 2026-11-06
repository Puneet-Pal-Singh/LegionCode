import { useMemo } from "react";
import { HarnessSelection } from "@legioncode/client-ui";
import { createHostedAppServerClient } from "../../services/api/appServerClient";
import { useHostedHarnessScope } from "./HostedHarnessScope";

/** The same persisted selection control in empty and established conversations. */
export function HostedHarnessPicker({ sessionId }: { sessionId: string }) {
  const binding = useHostedHarnessScope();
  const client = useMemo(() => createHostedAppServerClient().harness, []);
  if (binding.sessionId !== sessionId) return null;
  if (binding.selectionUnavailableReason)
    return (
      <p role="status" className="text-xs text-zinc-400">
        {binding.selectionUnavailableReason}
      </p>
    );
  if (!binding.selectionScope) return null;
  return (
    <HarnessSelection
      key={binding.connectionRevision}
      client={client}
      scope={binding.selectionScope}
      onSelectionChange={binding.acceptSelectionReceipt}
    />
  );
}
