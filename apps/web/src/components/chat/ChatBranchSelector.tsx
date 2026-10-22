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
  const { sessionId } = useRunContext();
  const repoFullNameRef = useRef(repo?.full_name ?? null);
  const sessionIdRef = useRef(sessionId);
  const isMountedRef = useRef(true);
  repoFullNameRef.current = repo?.full_name ?? null;
  sessionIdRef.current = sessionId;
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Fetch branches when repo changes
  useEffect(() => {
    if (!repo) {
      setBranches([]);
      return;
    }

    const fetchBranches = async () => {
      setIsLoading(true);

      try {
        const branchList = await listBranches(repo.owner.login, repo.name);
        setBranches(branchList);
      } catch (err) {
        console.error("Failed to fetch branches:", err);
        setBranches([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBranches();
  }, [repo]);

  // Don't render if no repo is selected
  if (!repo) {
    return null;
  }

  return (
    <BranchSelector
      currentBranch={branch}
      branches={branches}
      isLoading={isLoading}
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
