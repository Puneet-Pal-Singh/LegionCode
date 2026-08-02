import type { Repository } from "../../services/GitHubService";
import { EnvironmentSummaryMenu } from "../layout/workspace/EnvironmentSummaryMenu";

interface TopEnvironmentSummaryProps {
  repo: Repository | null;
  branch: string;
  onBranchChange: (branch: string) => void;
  onOpenChanges: () => void;
  onOpenCommit: () => void;
}

export function TopEnvironmentSummary({
  repo,
  branch,
  onBranchChange,
  onOpenChanges,
  onOpenCommit,
}: TopEnvironmentSummaryProps) {
  return (
    <EnvironmentSummaryMenu
      repo={repo}
      branch={branch || repo?.default_branch || "main"}
      changedFileCount={0}
      onBranchChange={onBranchChange}
      onOpenChanges={onOpenChanges}
      onOpenCommit={onOpenCommit}
    />
  );
}
