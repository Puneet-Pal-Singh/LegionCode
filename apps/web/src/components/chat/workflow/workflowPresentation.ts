import { useEffect, useState } from "react";
import {
  type ToolActivitySegment,
  type TurnWorkflowProjection,
  type WorkflowItem,
} from "@repo/platform-client-sdk";

export function useWorkflowClock(settled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (settled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [settled]);

  return now;
}

export function formatTurnDuration(
  startedAt: string | null,
  settledAt: string | null,
  now: number,
): string {
  if (!startedAt) return "0s";
  const end = settledAt ? Date.parse(settledAt) : now;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "0s";
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function resolveWorkflowTitle(
  projection: TurnWorkflowProjection,
  segments: readonly ToolActivitySegment[],
  duration: string,
): string {
  const terminal = projection.terminal;
  if (terminal) {
    if (terminal.state === "completed") return `Worked for ${duration}`;
    if (terminal.state === "interrupted") return `Stopped after ${duration}`;
    return `Failed after ${duration}`;
  }

  void segments;
  return `Working for ${duration}`;
}

export function itemDisplayText(item: WorkflowItem): string | null {
  const candidates = [
    item.safeSummary,
    item.detail,
    item.text,
    item.inputSummary,
    item.outputSummary,
  ];
  return candidates.find((candidate) => candidate?.trim()) ?? null;
}
