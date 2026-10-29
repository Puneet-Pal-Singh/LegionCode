/**
 * Chat Branch Selector Container
 *
 * Container component that manages branch data fetching and state
 * for the BranchSelector UI component.
 * Follows Container/Presentational pattern (SOLID principles).
 *
 * @module components/chat/ChatBranchSelector
 */

import { useState, useEffect, useRef } from "react";
import { BranchSelector } from "../github/BranchSelector";
import { useGitHub } from "../github/GitHubContextProvider";
import { useRunContext } from "../../hooks/useRunContext";
import { listBranches, Branch } from "../../services/GitHubService";
import { selectWorkspace } from "../../services/api/workspaceSelection";
import { useAuth } from "../../contexts/AuthContext";

/**
 * ChatBranchSelector Component
 *
 * Fetches branches for the current repository and renders
 * the BranchSelector UI component.
 *
 * Automatically fetches branches when the repository changes.
 * Handles loading states and errors.
 */
export function ChatBranchSelector({
  placement = "below",
  onBranchSelect,
}: {
  placement?: "above" | "below";
  onBranchSelect?: (branch: string) => void | Promise<void>;
}) {
  const { repo, branch, switchBranch } = useGitHub();
  const { user } = useAuth();
  const { sessionId } = useRunContext();
  const repoFullNameRef = useRef(repo?.full_name ?? null);
  const sessionIdRef = useRef(sessionId);
  const isMountedRef = useRef(true);
  repoFullNameRef.current = repo?.full_name ?? null;
  sessionIdRef.current = sessionId;
  const currentBranchesKey = JSON.stringify([
    user?.id ?? null,
    repo?.full_name ?? null,
  ]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesKey, setBranchesKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const visibleBranches = branchesKey === currentBranchesKey ? branches : [];
  const visibleLoadError = branchesKey === currentBranchesKey ? loadError : null;

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Fetch branches when repo changes
  useEffect(() => {
    let active = true;
    if (!repo) {
      setBranches([]);
      setLoadError(null);
      setIsLoading(false);
      return;
    }

    const fetchBranches = async () => {
      setBranches([]);
      setLoadError(null);
      setIsLoading(true);

      try {
        const branchList = await listBranches(repo.owner.login, repo.name, user?.id ?? null);
        if (!active) return;
        setBranches(branchList);
        setBranchesKey(currentBranchesKey);
      } catch (err) {
        if (!active) return;
        console.error("Failed to fetch branches:", err);
        setLoadError("Branches could not be loaded.");
        setBranchesKey(currentBranchesKey);
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void fetchBranches();
    return () => {
      active = false;
    };
  }, [repo, retryCount, user?.id, currentBranchesKey]);

  // Don't render if no repo is selected
  if (!repo) {
    return null;
  }

  return (
    <BranchSelector
      currentBranch={branch}
      branches={visibleBranches}
      isLoading={isLoading || branchesKey !== currentBranchesKey}
      loadError={visibleLoadError}
      onRetry={() => setRetryCount((count) => count + 1)}
      onBranchSelect={(selectedBranch) => {
        if (onBranchSelect) {
          void Promise.resolve(onBranchSelect(selectedBranch)).catch((error: unknown) => {
            console.warn("[workspace/select] Failed to persist branch selection:", error);
          });
          return;
        }
        const selectedRepository = repo.full_name;
        const selectedSession = sessionId;
        void selectWorkspace(repo, selectedBranch).then(() => {
          if (
            isMountedRef.current &&
            sessionIdRef.current === selectedSession &&
            repoFullNameRef.current === selectedRepository
          ) switchBranch(selectedBranch);
        }).catch((error: unknown) => {
          console.warn("[workspace/select] Failed to persist branch selection:", error);
        });
      }}
      placement={placement}
    />
  );
}
