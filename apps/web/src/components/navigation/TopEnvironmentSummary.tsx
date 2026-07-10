import type { Repository } from "../../services/GitHubService";
import { useGitStatus } from "../../hooks/useGitStatus";
import { EnvironmentSummaryMenu } from "../layout/workspace/EnvironmentSummaryMenu";

interface TopEnvironmentSummaryProps {
  sessionId: string;
  runId: string;
  repo: Repository | null;
  branch: string;
  enabled?: boolean;
  onBranchChange: (branch: string) => void;
  onOpenChanges: () => void;
  onOpenCommit: () => void;
}

export function TopEnvironmentSummary({
  sessionId,
  runId,
  repo,
  branch,
  enabled = true,
  onBranchChange,
  onOpenChanges,
  onOpenCommit,
}: TopEnvironmentSummaryProps) {
  const { status } = useGitStatus(
    runId,
    sessionId,
    Boolean(enabled && runId && sessionId),
  );
  return (
    <EnvironmentSummaryMenu
      repo={repo}
      branch={
        status?.branch?.trim() || branch || repo?.default_branch || "main"
      }
      changedFileCount={status?.files.length ?? 0}
      onBranchChange={onBranchChange}
      onOpenChanges={onOpenChanges}
      onOpenCommit={onOpenCommit}
    />
  );
}
