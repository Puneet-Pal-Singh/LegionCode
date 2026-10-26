import type { Repository } from "../../services/GitHubService";
import type { HostedSessionPullRequestsResponse } from "@legioncode/sdk";
import type { SavedChatSourcesProjection } from "../../lib/saved-chat-sources";
import { EnvironmentSummaryMenu } from "../layout/workspace/EnvironmentSummaryMenu";

export interface TopEnvironmentSummaryProps {
  repo: Repository | null;
  branch: string;
  pullRequestResult?: HostedSessionPullRequestsResponse;
  savedSources?: SavedChatSourcesProjection;
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
  savedSources,
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
      savedSources={savedSources}
      onBranchChange={onBranchChange}
      onOpenChanges={onOpenChanges}
      onOpenCommit={onOpenCommit}
      onOpenSources={onOpenSources}
      onOpen={onOpen}
    />
  );
}
