import { useEffect, useState } from "react";
import {
  lifecyclePhaseLabel,
  type LifecycleProjection,
} from "../../../services/lifecycle/LifecycleProjection.js";

interface TurnLifecycleStatusProps {
  projection: LifecycleProjection;
  testId?: string;
}

export function TurnLifecycleStatus({
  projection,
  testId,
}: TurnLifecycleStatusProps) {
  const nowMs = useCanonicalElapsedClock(projection);
  const label = lifecyclePhaseLabel(projection.phase);
  const elapsed = formatElapsed(
    projection.startedAt,
    projection.settledAt,
    nowMs,
  );
  const active =
    projection.phase === "starting" || projection.phase === "working";
  const visibleLabel =
    projection.phase === "working" && elapsed
      ? `${label} for ${elapsed}`
      : label;

  return (
    <div
      data-testid={testId}
      role="status"
      data-phase={projection.phase}
      data-started-at={projection.startedAt ?? undefined}
      className="border-b border-zinc-900/90 pb-2 text-sm font-medium text-zinc-500"
    >
      <span className={active ? "turn-lifecycle-shimmer" : undefined}>
        {visibleLabel}
      </span>
    </div>
  );
}

function useCanonicalElapsedClock(projection: LifecycleProjection): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const active =
    projection.startedAt !== null &&
    projection.settledAt === null &&
    (projection.phase === "starting" || projection.phase === "working");

  useEffect(() => {
    if (!active) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active, projection.startedAt]);

  return nowMs;
}

function formatElapsed(
  startedAt: string | null,
  settledAt: string | null,
  nowMs: number,
): string | null {
  if (!startedAt) {
    return null;
  }
  const startMs = Date.parse(startedAt);
  const endMs = settledAt ? Date.parse(settledAt) : nowMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
