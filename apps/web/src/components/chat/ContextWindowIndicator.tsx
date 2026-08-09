import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";
import { cn } from "../../lib/utils";
import { ContextUsageRing } from "./context/ContextUsageRing";
import {
  formatCompactTokenCount,
  formatCost,
} from "./context/context-format";

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
        <ContextUsageRing
          percent={percent}
          size={18}
          className="absolute inset-px text-zinc-400"
        />
      </button>
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-3 hidden w-60 -translate-x-1/2 rounded-xl border border-zinc-700/70 bg-[#242426] px-4 py-3 text-center text-sm shadow-2xl group-hover:block group-focus-within:block">
        <div className="text-zinc-400">Context window</div>
        <div className="mt-1 text-zinc-400">
          {percent === null
            ? "Usage unavailable"
            : `${percent}% used (${remainingPercent}% left)`}
        </div>
        {budget ? (
          <div className="mt-1 text-zinc-100">
            {formatCompactTokenCount(budget.tokensUsed)} /{" "}
            {formatCompactTokenCount(budget.contextWindowLimit)} tokens used
          </div>
        ) : (
          <div className="mt-1 text-zinc-500">
            Waiting for runtime-reported model context.
          </div>
        )}
        {usage?.cumulativeThreadCost != null ? (
          <div className="mt-1 text-zinc-500">
            {formatCost(usage.cumulativeThreadCost, usage.currency)} spent
          </div>
        ) : null}
        {canCompact ? (
          <div className="mt-2 border-t border-zinc-700/70 pt-2 text-zinc-300">
            /compact is available
          </div>
        ) : null}
      </div>
    </div>
  );
}
