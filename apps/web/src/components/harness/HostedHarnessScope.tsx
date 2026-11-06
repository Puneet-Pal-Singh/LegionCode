import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  HarnessSelectionReadRequest,
  HarnessSelectionResponse,
  HarnessStatusRequest,
} from "@legioncode/sdk";
import { createHostedAppServerClient } from "../../services/api/appServerClient";
import {
  captureHarnessSelection,
  type CapturedHarnessSelection,
} from "../../lib/chat-execution-selection";

interface HostedHarnessScopes {
  connectionScope: HarnessStatusRequest | null;
  selectionScope: HarnessSelectionReadRequest | null;
  sessionId: string | null;
  selectionUnavailableReason: string | null;
}
interface HostedHarnessBinding extends HostedHarnessScopes {
  selectionReceipt: HarnessSelectionResponse | null;
  acceptSelectionReceipt: (receipt: HarnessSelectionResponse) => void;
  readAdmissionSelection: () => Promise<CapturedHarnessSelection | undefined>;
}
const HostedHarnessScope = createContext<HostedHarnessBinding>({
  connectionScope: null,
  selectionScope: null,
  sessionId: null,
  selectionUnavailableReason: null,
  selectionReceipt: null,
  acceptSelectionReceipt: () => undefined,
  readAdmissionSelection: async () => undefined,
});

/** Display state is a server receipt. Every new admission reads the server again. */
export function HostedHarnessScopeProvider({
  children,
  ...scopes
}: HostedHarnessScopes & { children: ReactNode }) {
  const client = useMemo(() => createHostedAppServerClient().harness, []);
  const key = JSON.stringify(scopes.selectionScope);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [observed, setObserved] = useState<{
    key: string;
    receipt: HarnessSelectionResponse;
  } | null>(null);
  const scope = scopes.selectionScope;
  const acceptSelectionReceipt = useCallback(
    (receipt: HarnessSelectionResponse) => {
      if (
        currentKey.current !== key ||
        !scope ||
        receipt.environmentId !== scope.environmentId ||
        receipt.workspaceId !== scope.workspaceId ||
        receipt.threadId !== scope.threadId ||
        receipt.sessionId !== scope.sessionId
      )
        return;
      setObserved((current) =>
        current?.key === key && current.receipt.revision > receipt.revision
          ? current
          : { key, receipt },
      );
    },
    [key, scope],
  );
  const readAdmissionSelection = useCallback(async () => {
    if (!scope) return undefined;
    const receipt = await client.readSelection(scope);
    if (
      currentKey.current !== key ||
      receipt.environmentId !== scope.environmentId ||
      receipt.workspaceId !== scope.workspaceId ||
      receipt.threadId !== scope.threadId ||
      receipt.sessionId !== scope.sessionId
    )
      throw new Error(
        "Conversation selection scope changed. Try again in the current conversation.",
      );
    acceptSelectionReceipt(receipt);
    return captureHarnessSelection(receipt);
  }, [client, scope, key, acceptSelectionReceipt]);
  return (
    <HostedHarnessScope.Provider
      value={{
        ...scopes,
        selectionReceipt: observed?.key === key ? observed.receipt : null,
        acceptSelectionReceipt,
        readAdmissionSelection,
      }}
    >
      {children}
    </HostedHarnessScope.Provider>
  );
}
export function useHostedHarnessScope() {
  return useContext(HostedHarnessScope);
}
