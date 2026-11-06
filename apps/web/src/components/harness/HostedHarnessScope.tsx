import { createContext, useContext, type ReactNode } from "react";
import type {
  HarnessSelectionReadRequest,
  HarnessStatusRequest,
} from "@legioncode/sdk";

interface HostedHarnessScopes {
  connectionScope: HarnessStatusRequest | null;
  selectionScope: HarnessSelectionReadRequest | null;
  sessionId: string | null;
  selectionUnavailableReason: string | null;
}

const HostedHarnessScope = createContext<HostedHarnessScopes>({
  connectionScope: null,
  selectionScope: null,
  sessionId: null,
  selectionUnavailableReason: null,
});

/** Presentation scopes from authenticated App composition, never a selection store. */
export function HostedHarnessScopeProvider({
  children,
  ...scopes
}: HostedHarnessScopes & {
  children: ReactNode;
}) {
  return (
    <HostedHarnessScope.Provider value={scopes}>
      {children}
    </HostedHarnessScope.Provider>
  );
}

export function useHostedHarnessScope() {
  return useContext(HostedHarnessScope);
}
