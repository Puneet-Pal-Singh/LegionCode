import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-protocol";
import { cn } from "../../lib/utils";

interface ContextWindowIndicatorProps {
  budget: ContextBudgetSnapshot | null;
  usage: UsageCostSnapshot | null;
  onCompact?: () => void;
  onOpenDetails?: () => void;
}

export function ContextWindowIndicator({
  budget,
  usage,
  onCompact,
  onOpenDetails,
}: ContextWindowIndicatorProps) {
  const percent = budget ? Math.round(budget.utilizationPercent) : null;
  const remainingPercent = percent === null ? null : Math.max(0, 100 - percent);
  const canCompact =
    Boolean(onCompact) &&
    budget !== null &&
    budget.utilizationPercent >= budget.warningThresholdPercent;

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        aria-label={
          percent === null
            ? "Context window usage unavailable"
            : `Context window ${percent}% full`
        }
        onClick={onOpenDetails}
        className={cn(
          "relative h-5 w-5 rounded-full transition-colors",
          onOpenDetails ? "cursor-pointer hover:bg-zinc-800" : "cursor-default",
        )}
      >
        {percent === null ? (
          <span
            aria-hidden="true"
            className="absolute inset-[3px] rounded-full border border-zinc-600"
          />
        ) : (
          <span
            aria-hidden="true"
            className="absolute inset-[3px] rounded-full"
            style={{
              background: `conic-gradient(rgb(161 161 170) ${Math.min(percent, 100)}%, rgb(63 63 70) 0)`,
            }}
          />
        )}
        <span
          aria-hidden="true"
          className="absolute inset-[6px] rounded-full bg-[#1d1d1f]"
        />
      </button>
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-3 hidden w-60 -translate-x-1/2 rounded-2xl border border-zinc-700/70 bg-[#242426] px-4 py-3 text-center shadow-2xl group-hover:block group-focus-within:block">
        <div className="text-sm text-zinc-400">Context window:</div>
        <div className="mt-1 text-sm text-zinc-400">
          {percent === null
            ? "Usage unavailable"
            : `${percent}% used (${remainingPercent}% left)`}
        </div>
        {budget ? (
          <div className="mt-1 text-base text-zinc-100">
            {formatCount(budget.tokensUsed)} /{" "}
            {formatCount(budget.contextWindowLimit)} tokens used
          </div>
        ) : (
          <div className="mt-1 text-xs text-zinc-500">
            Waiting for runtime-reported model context.
          </div>
        )}
        {usage?.cumulativeThreadCost != null ? (
          <div className="mt-1 text-xs text-zinc-500">
            {formatCost(usage.cumulativeThreadCost)} spent
          </div>
        ) : null}
        {canCompact ? (
          <div className="mt-2 border-t border-zinc-700/70 pt-2 text-xs text-zinc-300">
            /compact is available
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}
