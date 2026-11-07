import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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

export interface HostedHarnessScopes {
  accountId: string | null;
  connectionScope: HarnessStatusRequest | null;
  selectionScope: HarnessSelectionReadRequest | null;
  sessionId: string | null;
  selectionUnavailableReason: string | null;
}
interface HostedHarnessBinding extends HostedHarnessScopes {
  connectionRevision: number;
  notifyConnectionsChanged: () => void;
  selectionReceipt: HarnessSelectionResponse | null;
  acceptSelectionReceipt: (receipt: HarnessSelectionResponse) => void;
  readAdmissionSelection: () => Promise<CapturedHarnessSelection | undefined>;
}
export const HostedHarnessScope = createContext<HostedHarnessBinding>({
  accountId: null,
  connectionRevision: 0,
  notifyConnectionsChanged: () => undefined,
  connectionScope: null,
  selectionScope: null,
  sessionId: null,
  selectionUnavailableReason: null,
  selectionReceipt: null,
  acceptSelectionReceipt: () => undefined,
  readAdmissionSelection: async () => undefined,
});

/** Display state is a server receipt. Every new admission reads the server again. */
export function useHostedHarnessScopeBinding(scopes: HostedHarnessScopes) {
  const [connectionRevision, setConnectionRevision] = useState(0);
  const notifyConnectionsChanged = useCallback(
    () => setConnectionRevision((value) => value + 1),
    [],
  );
  const client = useMemo(() => createHostedAppServerClient().harness, []);
  const key = JSON.stringify([
    scopes.accountId,
    scopes.connectionScope,
    scopes.selectionScope,
    scopes.sessionId,
  ]);
  // A return to an earlier scope gets a new token; old A → B → A replies
  // cannot become current again. Render never changes committed scope.
  const scopeToken = useMemo(() => Symbol(key), [key]);
  const committedScope = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    committedScope.current = scopeToken;
    return () => {
      committedScope.current = null;
    };
  }, [scopeToken]);
  const [observed, setObserved] = useState<{
    token: symbol;
    receipt: HarnessSelectionResponse;
  } | null>(null);
  const scope = scopes.selectionScope;
  const acceptSelectionReceipt = useCallback(
    (receipt: HarnessSelectionResponse) => {
      if (
        committedScope.current !== scopeToken ||
        !scope ||
        receipt.environmentId !== scope.environmentId ||
        receipt.workspaceId !== scope.workspaceId ||
        receipt.threadId !== scope.threadId ||
        receipt.sessionId !== scope.sessionId
      )
        return;
      setObserved((current) =>
        current?.token === scopeToken &&
        current.receipt.revision > receipt.revision
          ? current
          : { token: scopeToken, receipt },
      );
    },
    [scopeToken, scope],
  );
  const readAdmissionSelection = useCallback(async () => {
    if (committedScope.current !== scopeToken)
      throw new Error(
        "Conversation selection scope changed. Try again in the current conversation.",
      );
    if (!scope) return undefined;
    const receipt = await client.readSelection(scope);
    if (
      committedScope.current !== scopeToken ||
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
  }, [client, scope, scopeToken, acceptSelectionReceipt]);
  return {
    ...scopes,
    connectionRevision,
    notifyConnectionsChanged,
    selectionReceipt: observed?.token === scopeToken ? observed.receipt : null,
    acceptSelectionReceipt,
    readAdmissionSelection,
  };
}
export function useHostedHarnessScope() {
  return useContext(HostedHarnessScope);
}
