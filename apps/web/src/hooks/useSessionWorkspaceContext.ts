import { useEffect, useState } from "react";
import type { HostedSessionWorkspaceContext } from "@legioncode/sdk";
import { repositoryFromWorkspaceSelection } from "../lib/workspace-repository";
import { useGitHub } from "../components/github/GitHubContextProvider";
import { getSessionWorkspaceContext } from "../services/api/sessionMetadata";
import { loadSessionBranchPreference } from "../lib/session-branch-preference";

interface UseSessionWorkspaceContextOptions {
  authenticated: boolean;
  sessionId: string | null;
  persistenceReady: boolean;
  applySessionWorkspaceProjection: (
    sessionId: string,
    projection: Pick<
      HostedSessionWorkspaceContext,
      "sessionId" | "workspaceId" | "threadId"
    >,
  ) => void;
}

export function useSessionWorkspaceContext({
  authenticated,
  sessionId,
  persistenceReady,
  applySessionWorkspaceProjection,
}: UseSessionWorkspaceContextOptions) {
  const { setContext, clearContext } = useGitHub();
  const [context, setContextState] =
    useState<HostedSessionWorkspaceContext | null>(null);
  const [resolvedSessionId, setResolvedSessionId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!authenticated || !sessionId || !persistenceReady) {
      return;
    }

    const controller = new AbortController();
    void getSessionWorkspaceContext(sessionId, undefined, controller.signal)
      .then((resolved) => {
        if (controller.signal.aborted || resolved.sessionId !== sessionId)
          return;
        const preferredBranch = resolved.repository
          ? loadSessionBranchPreference(sessionId, resolved.repository.fullName)
          : null;
        const effective = preferredBranch
          ? { ...resolved, selectedBranch: preferredBranch }
          : resolved;
        setContextState(effective);
        setResolvedSessionId(sessionId);
        if (effective.repository) {
          setContext(
            repositoryFromWorkspaceSelection({
              repository: effective.repository,
              selectedBranch:
                effective.selectedBranch ?? effective.repository.defaultBranch,
            }),
            effective.selectedBranch ?? effective.repository.defaultBranch,
          );
        } else {
          clearContext();
        }
        applySessionWorkspaceProjection(sessionId, resolved);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setContextState(null);
        setResolvedSessionId(sessionId);
        clearContext();
        console.warn(
          "[session/workspaceContext] Failed to load session workspace context:",
          error,
        );
      });

    return () => controller.abort();
  }, [
    authenticated,
    sessionId,
    persistenceReady,
    clearContext,
    setContext,
    applySessionWorkspaceProjection,
  ]);

  const hasQueryScope = authenticated && Boolean(sessionId) && persistenceReady;
  return {
    context: hasQueryScope && context?.sessionId === sessionId ? context : null,
    isLoading: Boolean(hasQueryScope && resolvedSessionId !== sessionId),
    isResolved: Boolean(hasQueryScope && resolvedSessionId === sessionId),
    setContext: setContextState,
  };
}
