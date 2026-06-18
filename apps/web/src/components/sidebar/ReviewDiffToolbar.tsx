import {
  ChevronDown,
  ChevronUp,
  Ellipsis,
  Rows3,
  SquareSplitHorizontal,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { ReviewScopeDropdown } from "../git/ReviewScopeDropdown";
import type { ReviewScope } from "../../services/review/ReviewSourceResolver";
import type { DiffLayout } from "./useChangesPanelViewState";

export function ReviewDiffToolbar({
  reviewScope,
  onReviewScopeChange,
  layout,
  onLayoutChange,
  wordWrap,
  onWordWrapChange,
  hunksCollapsed,
  onToggleHunks,
}: {
  reviewScope: ReviewScope;
  onReviewScopeChange: (scope: ReviewScope) => void;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  wordWrap: boolean;
  onWordWrapChange: (enabled: boolean) => void;
  hunksCollapsed: boolean;
  onToggleHunks: () => void;
}) {
  const [showViewMenu, setShowViewMenu] = useState(false);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 pb-3">
      <ReviewScopeDropdown value={reviewScope} onChange={onReviewScopeChange} />
      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowViewMenu((previous) => !previous)}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-1.5 text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
            aria-haspopup="menu"
            aria-expanded={showViewMenu}
            aria-label="Diff view options"
          >
            <Ellipsis size={14} />
          </button>
          {showViewMenu ? (
            <div
              role="menu"
              className="absolute right-0 top-9 z-20 min-w-48 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onWordWrapChange(!wordWrap);
                  setShowViewMenu(false);
                }}
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-900 hover:text-white"
              >
                {wordWrap ? "Disable word wrap" : "Enable word wrap"}
              </button>
            </div>
          ) : null}
        </div>
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => onLayoutChange("stacked")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors",
              layout === "stacked"
                ? "bg-zinc-800 text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <Rows3 size={13} />
            Unified
          </button>
          <button
            type="button"
            onClick={() => onLayoutChange("split")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors",
              layout === "split"
                ? "bg-zinc-800 text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <SquareSplitHorizontal size={13} />
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={onToggleHunks}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
        >
          {hunksCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          {hunksCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
    </div>
  );
}
