import { useEffect, useMemo, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { buildActivityFeedViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "../../../services/activity/TranscriptActivityParts.js";
import {
  isRunEventActivityOpen,
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
  const eventActivityOpen = useMemo(
    () => isRunEventActivityOpen({ runId: input.runId, events: input.events }),
    [input.events, input.runId],
  );
  const persistedFeedOpen = scopedPersistedFeed?.status === "RUNNING";
  const resolvedActivityOpen =
    input.isLoading || eventActivityOpen || persistedFeedOpen;
  const liveFeed = useMemo(
    () =>
      projectRunEventsToActivitySnapshot({
        runId: input.runId,
        events: input.events,
        isActive: resolvedActivityOpen,
      }),
    [resolvedActivityOpen, input.events, input.runId],
  );
  const scopedFeed = useMemo(
    () => mergeActivitySnapshots(scopedPersistedFeed, liveFeed),
    [liveFeed, scopedPersistedFeed],
  );
  const viewModel = useMemo(() => {
    const liveViewModel = buildActivityFeedViewModel(scopedFeed, nowMs);
    const transcriptTurns = buildTranscriptActivityTurns(input.messages);
    return {
      ...liveViewModel,
      turns: mergeTranscriptAndLiveActivityTurns(
        transcriptTurns,
        liveViewModel.turns,
      ),
    };
  }, [input.messages, nowMs, scopedFeed]);

  const presentationLogSnapshot = useMemo(() => {
    const activeTurnKey =
      viewModel.turns.find((turn) => turn.isActiveTurn)?.key ?? null;
    const liveItemCount = liveFeed?.items.length ?? 0;
    const persistedItemCount = scopedPersistedFeed?.items.length ?? 0;
    const rowCount = viewModel.turns.reduce(
      (total, turn) => total + turn.rows.length,
      0,
    );
    return {
      activeTurnKey,
      liveItemCount,
      liveStatus: liveFeed?.status ?? null,
      persistedItemCount,
      persistedStatus: scopedPersistedFeed?.status ?? null,
      rowCount,
      sourceMode: resolveActivitySourceMode(scopedPersistedFeed, liveFeed),
      turnCount: viewModel.turns.length,
      turnKeys: viewModel.turns.map((turn) => turn.key).join(","),
    };
  }, [liveFeed, scopedPersistedFeed, viewModel.turns]);

  useEffect(() => {
    logClientEvent("run/presentation", "updated", {
      runId: input.runId,
      loading: input.isLoading,
      eventActivityOpen,
      persistedFeedOpen,
      resolvedActivityOpen,
      feedStatus: scopedFeed?.status ?? null,
      eventCount: input.events.length,
      liveItemCount: presentationLogSnapshot.liveItemCount,
      liveStatus: presentationLogSnapshot.liveStatus,
      persistedItemCount: presentationLogSnapshot.persistedItemCount,
      persistedStatus: presentationLogSnapshot.persistedStatus,
      sourceMode: presentationLogSnapshot.sourceMode,
      activeTurnKey: presentationLogSnapshot.activeTurnKey,
      turnKeys: presentationLogSnapshot.turnKeys,
      turnCount: presentationLogSnapshot.turnCount,
      rowCount: presentationLogSnapshot.rowCount,
    });
  }, [
    input.events.length,
    input.isLoading,
    input.runId,
    eventActivityOpen,
    persistedFeedOpen,
    resolvedActivityOpen,
    presentationLogSnapshot,
    scopedFeed?.status,
  ]);

  useEffect(() => {
    if (!resolvedActivityOpen && scopedFeed?.status !== "RUNNING") return;
    const timerId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timerId);
  }, [input.runId, resolvedActivityOpen, scopedFeed?.status]);

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

function resolveActivitySourceMode(
  persisted: ActivityFeed | null,
  live: ActivityFeed | null,
): "none" | "persisted" | "live" | "merged" {
  if (persisted && live) return "merged";
  if (live) return "live";
  if (persisted) return "persisted";
  return "none";
}
