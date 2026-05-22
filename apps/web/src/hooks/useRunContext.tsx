/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo } from "react";

interface RunContextValue {
  runId: string | null;
  sessionId: string | null;
}

const RunContext = createContext<RunContextValue | undefined>(undefined);

export function useRunContext(): RunContextValue {
  const context = useContext(RunContext);
  if (!context) {
    throw new Error("useRunContext must be used within RunContextProvider");
  }
  return context;
}

export function RunContextProvider({
  children,
  runId,
  sessionId,
}: {
  children: React.ReactNode;
  runId: string;
  sessionId: string;
}) {
  const value = useMemo(() => ({ runId, sessionId }), [runId, sessionId]);

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}
