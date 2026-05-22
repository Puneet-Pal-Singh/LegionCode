/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect } from "react";

interface RunContextValue {
  runId: string | null;
  sessionId: string | null;
}

const RunContext = createContext<RunContextValue | null>(null);
const SESSION_RUN_ID_KEY = "currentRunId";
const SESSION_ID_KEY = "currentSessionId";

export function useRunContext(): RunContextValue {
  const context = useContext(RunContext);
  
  if (!context) {
    // Fallback for when context is not available
    const runId = sessionStorage.getItem(SESSION_RUN_ID_KEY);
    const sessionId = sessionStorage.getItem(SESSION_ID_KEY);
    return { runId, sessionId };
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
  useEffect(() => {
    sessionStorage.setItem(SESSION_RUN_ID_KEY, runId);
    sessionStorage.setItem(SESSION_ID_KEY, sessionId);

    return () => {
      if (sessionStorage.getItem(SESSION_RUN_ID_KEY) === runId) {
        sessionStorage.removeItem(SESSION_RUN_ID_KEY);
      }
      if (sessionStorage.getItem(SESSION_ID_KEY) === sessionId) {
        sessionStorage.removeItem(SESSION_ID_KEY);
      }
    };
  }, [runId, sessionId]);

  return (
    <RunContext.Provider value={{ runId, sessionId }}>
      {children}
    </RunContext.Provider>
  );
}
