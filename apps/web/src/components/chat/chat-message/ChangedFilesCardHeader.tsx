import { ArrowUpRight, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "../../../lib/utils";
import { ChangeStats } from "./DiffStatistics";
import type { ChangeLineStats } from "./types";

export function ChangedFilesCardHeader({
  fileCount,
  totals,
  isExpanded,
  onReviewOpen,
  onToggleExpanded,
}: {
  fileCount: number;
  totals: ChangeLineStats;
  isExpanded: boolean;
  onReviewOpen?: () => void;
  onToggleExpanded: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-2.5",
        !isExpanded && "border-b-0",
      )}
    >
      <div className="flex items-center gap-3 text-sm font-semibold text-zinc-100">
        <span>
          {fileCount} {fileCount === 1 ? "file changed" : "files changed"}
        </span>
        {fileCount > 1 && <ChangeStats {...totals} />}
      </div>
      <div className="flex items-center gap-4">
        {onReviewOpen && (
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
            onClick={onReviewOpen}
          >
            <span>Review</span>
            <ArrowUpRight size={14} />
          </button>
        )}
        <button
          type="button"
          className="text-zinc-500 transition-colors hover:text-zinc-300"
          onClick={onToggleExpanded}
          title={isExpanded ? "Collapse files" : "Expand files"}
        >
          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
    </div>
  );
}
