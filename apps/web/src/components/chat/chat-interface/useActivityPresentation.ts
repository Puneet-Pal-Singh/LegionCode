import { useEffect, useMemo, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { buildActivityFeedViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "../../../services/activity/TranscriptActivityParts.js";
import type { useRunActivityFeed } from "../../../hooks/useRunActivityFeed.js";

type ActivityFeed = ReturnType<typeof useRunActivityFeed>["feed"];

interface ActivityPresentationInput {
  runId: string;
  messages: Message[];
  feed: ActivityFeed;
  isLoading: boolean;
}

export function useActivityPresentation(input: ActivityPresentationInput) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scopedFeed = input.feed?.runId === input.runId ? input.feed : null;
  const displayFeed = useMemo(
    () =>
      !input.isLoading && scopedFeed?.status === "RUNNING"
        ? { ...scopedFeed, status: "CANCELLED" as const }
        : scopedFeed,
    [input.isLoading, scopedFeed],
  );
  const viewModel = useMemo(() => {
    const liveViewModel = buildActivityFeedViewModel(displayFeed, nowMs);
    return {
      ...liveViewModel,
      turns: mergeTranscriptAndLiveActivityTurns(
        buildTranscriptActivityTurns(input.messages),
        liveViewModel.turns,
      ),
    };
  }, [displayFeed, input.messages, nowMs]);

  useEffect(() => {
    if (scopedFeed?.status !== "RUNNING") return;
    const timerId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timerId);
  }, [input.runId, scopedFeed?.status]);

  const scrollSignal = useMemo(
    () =>
      viewModel.turns
        .map(
          (turn) =>
            `${turn.key}:${turn.rows.length}:${turn.summaryLabel}:${turn.isActiveTurn ? "active" : "idle"}`,
        )
        .join("|"),
    [viewModel.turns],
  );

  return { scopedFeed, viewModel, scrollSignal };
}
