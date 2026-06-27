import { useEffect, useMemo, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { buildActivityFeedViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "../../../services/activity/TranscriptActivityParts.js";
import {
  mergeActivitySnapshots,
  projectRunEventsToActivitySnapshot,
} from "../../../services/activity/RunEventActivitySnapshot.js";
import type { useRunActivityFeed } from "../../../hooks/useRunActivityFeed.js";
import type { useRunEvents } from "../../../hooks/useRunEvents.js";
import { logClientEvent } from "../../../lib/client-logger.js";

type ActivityFeed = ReturnType<typeof useRunActivityFeed>["feed"];

interface ActivityPresentationInput {
  runId: string;
  messages: Message[];
  feed: ActivityFeed;
  events: ReturnType<typeof useRunEvents>["events"];
  isLoading: boolean;
}

export function useActivityPresentation(input: ActivityPresentationInput) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scopedPersistedFeed =
    input.feed?.runId === input.runId ? input.feed : null;
  const liveFeed = useMemo(
    () =>
      projectRunEventsToActivitySnapshot({
        runId: input.runId,
        events: input.events,
        isActive: input.isLoading,
        fallbackSessionId: scopedPersistedFeed?.sessionId,
      }),
    [
      input.events,
      input.isLoading,
      input.runId,
      scopedPersistedFeed?.sessionId,
    ],
  );
  const scopedFeed = useMemo(
    () => mergeActivitySnapshots(scopedPersistedFeed, liveFeed),
    [liveFeed, scopedPersistedFeed],
  );
  const viewModel = useMemo(() => {
    const liveViewModel = buildActivityFeedViewModel(scopedFeed, nowMs);
    return {
      ...liveViewModel,
      turns: mergeTranscriptAndLiveActivityTurns(
        buildTranscriptActivityTurns(input.messages),
        liveViewModel.turns,
      ),
    };
  }, [input.messages, nowMs, scopedFeed]);

  const activeTurnKey = viewModel.turns.find((turn) => turn.isActiveTurn)?.key;
  useEffect(() => {
    logClientEvent("run/presentation", "updated", {
      runId: input.runId,
      loading: input.isLoading,
      feedStatus: scopedFeed?.status ?? null,
      activeTurnKey: activeTurnKey ?? null,
      turnCount: viewModel.turns.length,
    });
  }, [
    activeTurnKey,
    input.isLoading,
    input.runId,
    scopedFeed?.status,
    viewModel.turns.length,
  ]);

  useEffect(() => {
    if (!input.isLoading && scopedFeed?.status !== "RUNNING") return;
    const timerId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timerId);
  }, [input.isLoading, input.runId, scopedFeed?.status]);

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
