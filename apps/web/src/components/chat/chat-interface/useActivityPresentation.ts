import { useEffect, useMemo, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { buildActivityFeedViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import {
  buildTranscriptActivityTurns,
  mergeTranscriptAndLiveActivityTurns,
} from "../../../services/activity/TranscriptActivityParts.js";
import type { useRunActivityFeed } from "../../../hooks/useRunActivityFeed.js";
import { logClientEvent } from "../../../lib/client-logger.js";

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
  const viewModel = useMemo(() => {
    const liveViewModel = buildActivityFeedViewModel(scopedFeed, nowMs);
    const mergedTurns = mergeTranscriptAndLiveActivityTurns(
      buildTranscriptActivityTurns(input.messages),
      liveViewModel.turns,
    );
    return {
      ...liveViewModel,
      turns: addOptimisticThinkingTurn(
        input.messages,
        mergedTurns,
        input.isLoading,
      ),
    };
  }, [input.isLoading, input.messages, nowMs, scopedFeed]);

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

type ActivityTurn = ReturnType<
  typeof buildActivityFeedViewModel
>["turns"][number];

function addOptimisticThinkingTurn(
  messages: Message[],
  turns: ActivityTurn[],
  isLoading: boolean,
): ActivityTurn[] {
  if (!isLoading) return turns;
  const userMessage = findLatestUserMessage(messages);
  if (!userMessage) return turns;
  const existingIndex = findCurrentTurnIndex(turns, userMessage);
  const existing = turns[existingIndex];
  if (existing?.isActiveTurn && existing.hasVisibleRows) return turns;

  const optimisticTurn = createOptimisticThinkingTurn(userMessage);
  if (!existing) return [...turns, optimisticTurn];
  const next = [...turns];
  next[existingIndex] = existing.hasVisibleRows
    ? mergeOptimisticThinking(existing, optimisticTurn)
    : optimisticTurn;
  return next;
}

function findCurrentTurnIndex(
  turns: ActivityTurn[],
  userMessage: Message,
): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      turn?.key === userMessage.id ||
      turn?.userPrompt?.trim() === userMessage.content.trim()
    ) {
      return index;
    }
  }
  return -1;
}

function findLatestUserMessage(messages: Message[]): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim()) return message;
  }
  return null;
}

function createOptimisticThinkingTurn(message: Message): ActivityTurn {
  return {
    key: message.id,
    userPrompt: message.content,
    elapsedLabel: "Working for 1s",
    summaryLabel: "Thinking",
    defaultCollapsed: false,
    isActiveTurn: true,
    hasVisibleRows: true,
    rows: [
      {
        kind: "reasoning",
        key: `optimistic:${message.id}:thinking`,
        label: "Thinking",
        summary: "",
        status: "active",
      },
    ],
  };
}

function mergeOptimisticThinking(
  existing: ActivityTurn,
  optimistic: ActivityTurn,
): ActivityTurn {
  return {
    ...existing,
    defaultCollapsed: false,
    isActiveTurn: true,
    rows: [...existing.rows, ...optimistic.rows],
  };
}
