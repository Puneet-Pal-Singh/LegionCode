import type { Repository } from "../../services/GitHubService";
import type { HostedSessionPullRequestsResponse } from "@legioncode/sdk";
import { EnvironmentSummaryMenu } from "../layout/workspace/EnvironmentSummaryMenu";

interface TopEnvironmentSummaryProps {
  repo: Repository | null;
  branch: string;
  pullRequestResult?: HostedSessionPullRequestsResponse;
  sourceCount?: number;
  changedFileCount?: number;
  onBranchChange?: (branch: string) => void;
  onOpenChanges?: () => void;
  onOpenCommit?: () => void;
  onOpenSources?: () => void;
  onOpen?: () => void;
}

export function TopEnvironmentSummary({
  repo,
  branch,
  pullRequestResult,
  sourceCount,
  changedFileCount,
  onBranchChange,
  onOpenChanges,
  onOpenCommit,
  onOpenSources,
  onOpen,
}: TopEnvironmentSummaryProps) {
  return (
    <EnvironmentSummaryMenu
      repo={repo}
      branch={branch || repo?.default_branch || "main"}
      changedFileCount={changedFileCount}
      pullRequestResult={pullRequestResult}
      sourceCount={sourceCount}
      onBranchChange={onBranchChange}
      onOpenChanges={onOpenChanges}
      onOpenCommit={onOpenCommit}
      onOpenSources={onOpenSources}
      onOpen={onOpen}
    />
  );
}
