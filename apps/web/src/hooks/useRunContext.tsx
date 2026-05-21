/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo } from "react";

interface RunContextValue {
  runId: string | null;
  sessionId: string | null;
}

const RunContext = createContext<RunContextValue>({
  runId: null,
  sessionId: null,
});

export function useRunContext(): RunContextValue {
  return useContext(RunContext);
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
