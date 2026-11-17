import { useEffect, useState } from "react";
import {
  EnvironmentSummaryMenu as SharedEnvironmentSummaryMenu,
  type EnvironmentSummaryMenuProps as SharedEnvironmentSummaryMenuProps,
} from "@legioncode/client-ui";
import type { Branch, Repository } from "../../../services/GitHubService";
import { listBranches } from "../../../services/GitHubService";
import { BranchSelectorPanel } from "../../github/BranchSelector";
import { useAuth } from "../../../contexts/AuthContext";

export type EnvironmentSummaryMenuProps = Omit<
  SharedEnvironmentSummaryMenuProps,
  "repo" | "renderBranchPanel"
> & { repo: Repository | null };

export function EnvironmentSummaryMenu(props: EnvironmentSummaryMenuProps) {
  const { user } = useAuth();
  const {
    branches,
    loading,
    error: branchError,
    retry: retryBranches,
  } = useBranches(props.repo, user?.id ?? null);
  return (
    <SharedEnvironmentSummaryMenu
      {...props}
      renderBranchPanel={({ panelRef, style, onClose }) => (
        <BranchSelectorPanel
          branches={branches}
          currentBranch={props.branch}
          isLoading={loading}
          loadError={branchError}
          onRetry={retryBranches}
          panelRef={panelRef}
          style={style}
          className="fixed left-0 top-0 z-[130] overflow-y-auto"
          onBranchSelect={(branch) => {
            props.onBranchChange?.(branch);
            onClose();
          }}
        />
      )}
    />
  );
}

function useBranches(
  repo: Repository | null,
  accountId: string | null,
): {
  branches: Branch[];
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const currentKey = JSON.stringify([accountId, repo?.full_name ?? null]);
  useEffect(() => {
    let active = true;
    if (!repo) {
      // Clear data from the previously selected repository.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBranches([]);
      setError(null);
      setLoading(false);
      return;
    }
    setBranches([]);
    setError(null);
    setLoading(true);
    void listBranches(repo.owner.login, repo.name, accountId)
      .then((items) => {
        if (active) {
          setBranches(items);
          setResultKey(currentKey);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          console.error("Failed to fetch branches:", cause);
          setError("Branches could not be loaded.");
          setResultKey(currentKey);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, currentKey, repo, retryCount]);
  return {
    branches: resultKey === currentKey ? branches : [],
    loading: loading || Boolean(repo && resultKey !== currentKey),
    error: resultKey === currentKey ? error : null,
    retry: () => setRetryCount((count) => count + 1),
  };
}
