/**
 * Chat Branch Selector Container
 *
 * Container component that manages branch data fetching and state
 * for the BranchSelector UI component.
 * Follows Container/Presentational pattern (SOLID principles).
 *
 * @module components/chat/ChatBranchSelector
 */

import { useState, useEffect } from "react";
import { BranchSelector } from "../github/BranchSelector";
import { useGitHub } from "../github/GitHubContextProvider";
import { listBranches, Branch } from "../../services/GitHubService";

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
}: {
  placement?: "above" | "below";
}) {
  const { repo, branch, switchBranch } = useGitHub();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(false);

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
      onBranchSelect={switchBranch}
      placement={placement}
    />
  );
}
