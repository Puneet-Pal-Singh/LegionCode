import { createContext, useContext, type ReactNode } from "react";
import type { HarnessSelectionReadRequest } from "@legioncode/sdk";

const HostedHarnessScope = createContext<HarnessSelectionReadRequest | null>(
  null,
);

/** Presentation scope from authenticated App composition, never a selection store. */
export function HostedHarnessScopeProvider({
  scope,
  children,
}: {
  scope: HarnessSelectionReadRequest | null;
  children: ReactNode;
}) {
  return (
    <HostedHarnessScope.Provider value={scope}>
      {children}
    </HostedHarnessScope.Provider>
  );
}

export function useHostedHarnessScope() {
  return useContext(HostedHarnessScope);
}
