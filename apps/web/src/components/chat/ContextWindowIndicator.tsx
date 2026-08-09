import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";
import { cn } from "../../lib/utils";
import { ContextUsageRing } from "./context/ContextUsageRing";
import { ContextWindowTooltip } from "./context/ContextWindowTooltip";

interface ContextWindowIndicatorProps {
  budget: ContextBudgetSnapshot | null;
  usage: UsageCostSnapshot | null;
  onCompact?: () => void;
  onOpenDetails?: () => void;
  compact?: boolean;
}

export function ContextWindowIndicator({
  budget,
  usage,
  onCompact,
  onOpenDetails,
  compact = false,
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
          "relative flex items-center justify-center rounded-md transition-colors",
          compact ? "size-6" : "size-7",
          onOpenDetails
            ? "cursor-pointer hover:bg-zinc-800/90"
            : "cursor-default",
        )}
      >
        <ContextUsageRing
          percent={percent}
          size={compact ? 12 : 16}
          className="text-zinc-400"
        />
      </button>
      <ContextWindowTooltip
        budget={budget}
        usage={usage}
        percent={percent}
        remainingPercent={remainingPercent}
        canCompact={canCompact}
      />
    </div>
  );
}
