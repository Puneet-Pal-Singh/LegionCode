import { useCallback, useEffect, useRef, useState } from "react";
import type { HostedAccountCommand, HostedAccountSnapshot } from "../../shared/hosted-account";

export interface DesktopHostedAccountControls {
  snapshot: HostedAccountSnapshot | null;
  busy: boolean;
  error: string | null;
  refresh(): Promise<HostedAccountSnapshot | null>;
  perform(operation: HostedAccountCommand["operation"]): Promise<HostedAccountSnapshot | null>;
}

/** Safe account metadata only. Main retains the private cookie jar and request custody. */
export function useDesktopHostedAccount(): DesktopHostedAccountControls {
  const [snapshot, setSnapshot] = useState<HostedAccountSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const command = useRef<{ operation: HostedAccountCommand["operation"]; promise: Promise<HostedAccountSnapshot | null> } | null>(null);

  const invoke = useCallback((operation: HostedAccountCommand["operation"]): Promise<HostedAccountSnapshot | null> => {
    const captured = ++revision.current;
    setBusy(true);
    setError(null);
    return window.desktop.hostedAccount({ operation }).then((next) => {
      if (!mounted.current || captured !== revision.current) return null;
      setSnapshot(next);
      return next;
    }).catch(() => {
      if (mounted.current && captured === revision.current) {
        setError("Hosted account connection could not be checked. Try again.");
      }
      return null;
    }).finally(() => {
      if (mounted.current && captured === revision.current) setBusy(false);
    });
  }, []);
  const refresh = useCallback(() => invoke("status"), [invoke]);
  const perform = useCallback((operation: HostedAccountCommand["operation"]) => {
    if (command.current) {
      if (command.current.operation === operation) return command.current.promise;
      setError("Another account operation is still pending.");
      return Promise.resolve(null);
    }
    const original = invoke(operation);
    const pending = { operation, promise: original };
    command.current = pending;
    void original.finally(() => { if (command.current === pending) command.current = null; });
    return original;
  }, [invoke]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; revision.current += 1; };
  }, [refresh]);
  return { snapshot, busy, error, refresh, perform };
}
