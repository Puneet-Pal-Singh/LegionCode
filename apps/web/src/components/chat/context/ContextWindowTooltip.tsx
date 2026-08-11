import { formatCompactTokenCount, formatCost } from "./context-format";

interface ContextWindowTooltipBudget {
  tokensUsed: number;
  contextWindowLimit: number;
}

interface ContextWindowTooltipUsage {
  cumulativeThreadCost: number | null;
  currency: string;
}

interface ContextWindowTooltipProps {
  budget: ContextWindowTooltipBudget | null;
  usage: ContextWindowTooltipUsage | null;
  percent: number | null;
  remainingPercent: number | null;
  canCompact: boolean;
}

export function ContextWindowTooltip({
  budget,
  usage,
  percent,
  remainingPercent,
  canCompact,
}: ContextWindowTooltipProps) {
  return (
    <div className="ui-surface-popover pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-64 -translate-x-1/2 p-3 text-center group-hover:block group-focus-within:block">
      <div className="text-sm font-medium text-zinc-200">Context window</div>
      <div className="mt-1 text-xs text-zinc-400">
        {percent === null
          ? "Usage unavailable"
          : `${percent}% used (${remainingPercent}% left)`}
      </div>
      {budget ? (
        <div className="mt-2 text-sm font-medium text-zinc-100">
          {formatCompactTokenCount(budget.tokensUsed)} /{" "}
          {formatCompactTokenCount(budget.contextWindowLimit)} tokens used
        </div>
      ) : (
        <div className="mt-2 text-xs text-zinc-500">
          Waiting for runtime-reported model context.
        </div>
      )}
      {usage?.cumulativeThreadCost != null ? (
        <div className="mt-1 text-xs text-zinc-500">
          {formatCost(usage.cumulativeThreadCost, usage.currency)} spent
        </div>
      ) : null}
      {canCompact ? (
        <div className="mt-2 border-t border-zinc-800 pt-2 text-xs text-zinc-300">
          /compact is available
        </div>
      ) : null}
    </div>
  );
}
