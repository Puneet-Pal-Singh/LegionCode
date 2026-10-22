import { useEffect, useState } from "react";
import type { HostedSessionWorkspaceContext } from "@legioncode/sdk";
import type { Repository } from "../services/GitHubService";
import { useGitHub } from "../components/github/GitHubContextProvider";
import { getSessionWorkspaceContext } from "../services/api/sessionMetadata";
import { loadSessionBranchPreference } from "../lib/session-branch-preference";

interface UseSessionWorkspaceContextOptions {
  authenticated: boolean;
  sessionId: string | null;
  persistenceReady: boolean;
  updateSession: (
    sessionId: string,
    patch: { workspaceId: string | null; threadId: string | null },
    options?: { preserveActivityTimestamp?: boolean },
  ) => void;
}

export function useSessionWorkspaceContext({
  authenticated,
  sessionId,
  persistenceReady,
  updateSession,
}: UseSessionWorkspaceContextOptions) {
  const { setContext, clearContext } = useGitHub();
  const [context, setContextState] = useState<HostedSessionWorkspaceContext | null>(null);
  const [resolvedSessionId, setResolvedSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || !sessionId || !persistenceReady) {
      return;
    }

    const controller = new AbortController();
    void getSessionWorkspaceContext(sessionId, undefined, controller.signal)
      .then((resolved) => {
        if (controller.signal.aborted || resolved.sessionId !== sessionId) return;
        const preferredBranch = resolved.repository
          ? loadSessionBranchPreference(sessionId, resolved.repository.fullName)
          : null;
        const effective = preferredBranch
          ? { ...resolved, selectedBranch: preferredBranch }
          : resolved;
        setContextState(effective);
        setResolvedSessionId(sessionId);
        if (effective.repository) {
          setContext(toRepository(effective.repository), effective.selectedBranch ?? effective.repository.defaultBranch);
        } else {
          clearContext();
        }
        updateSession(sessionId, {
          workspaceId: resolved.workspaceId,
          threadId: resolved.threadId,
        }, { preserveActivityTimestamp: true });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setContextState(null);
        setResolvedSessionId(sessionId);
        clearContext();
        console.warn("[session/workspaceContext] Failed to load session workspace context:", error);
      });

    return () => controller.abort();
  }, [authenticated, sessionId, persistenceReady, clearContext, setContext, updateSession]);

  const hasQueryScope = authenticated && Boolean(sessionId) && persistenceReady;
  return {
    context: hasQueryScope && context?.sessionId === sessionId ? context : null,
    isLoading: Boolean(hasQueryScope && resolvedSessionId !== sessionId),
    isResolved: Boolean(hasQueryScope && resolvedSessionId === sessionId),
    setContext: setContextState,
  };
}

function toRepository(repository: NonNullable<HostedSessionWorkspaceContext["repository"]>): Repository {
  return {
    id: Number(repository.providerRepoId ?? 0),
    name: repository.name,
    full_name: repository.fullName,
    owner: { login: repository.owner, avatar_url: "" },
    description: null,
    private: false,
    html_url: repository.repoUrl,
    clone_url: `${repository.repoUrl}.git`,
    default_branch: repository.defaultBranch,
    stargazers_count: 0,
    language: null,
    updated_at: repository.updatedAt,
  };
}
