import { useEffect, useMemo, useState } from "react";
import type { ActivityFeedSnapshot } from "@repo/shared-types";
import {
  buildStaticActivityFeedViewModel,
  withActivityFeedElapsedLabels,
} from "../../../services/activity/ActivityFeedViewModel.js";
import { ActivityTurn } from "./ActivityTurn.js";

interface ActivityFeedProps {
  feed: ActivityFeedSnapshot | null;
  isLoading: boolean;
  onUsePlanInBuild?: () => void;
}

export function ActivityFeed({
  feed,
  isLoading,
  onUsePlanInBuild,
}: ActivityFeedProps) {
  if (!feed && !isLoading) {
    return null;
  }

  return (
    <ActivityFeedContent
      key={feed?.runId ?? "empty"}
      feed={feed}
      isLoading={isLoading}
      onUsePlanInBuild={onUsePlanInBuild}
    />
  );
}

function ActivityFeedContent({
  feed,
  isLoading,
  onUsePlanInBuild,
}: ActivityFeedProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isActiveRun = feed?.status === "RUNNING";

  useEffect(() => {
    if (!isActiveRun) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isActiveRun]);

  const staticViewModel = useMemo(
    () => buildStaticActivityFeedViewModel(feed),
    [feed],
  );
  const viewModel = useMemo(
    () => withActivityFeedElapsedLabels(staticViewModel, nowMs),
    [staticViewModel, nowMs],
  );
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  return (
    <section className="space-y-4">
      {viewModel.turns.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">
          {isLoading
            ? "Waiting for activity from the current run."
            : "No activity recorded yet."}
        </div>
      ) : (
        viewModel.turns.map((turn) => (
          <ActivityTurn
            key={turn.key}
            turn={turn}
            expanded={expandedTurns[turn.key] ?? !turn.defaultCollapsed}
            onToggleTurn={() =>
              setExpandedTurns((current) => ({
                ...current,
                [turn.key]: !(current[turn.key] ?? !turn.defaultCollapsed),
              }))
            }
            expandedRows={expandedRows}
            onToggleRow={(rowKey, expanded) =>
              setExpandedRows((current) => ({
                ...current,
                [rowKey]: expanded,
              }))
            }
            onUsePlanInBuild={onUsePlanInBuild}
          />
        ))
      )}
    </section>
  );
}
