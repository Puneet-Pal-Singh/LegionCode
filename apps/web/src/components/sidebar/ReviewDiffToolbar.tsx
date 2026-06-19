import {
  ChevronDown,
  ChevronUp,
  Ellipsis,
  GitBranch,
  Rows3,
  SquareSplitHorizontal,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";
import { ReviewScopeDropdown } from "../git/ReviewScopeDropdown";
import type { ReviewScope } from "../../services/review/ReviewSourceResolver";
import type { DiffLayout } from "./useChangesPanelViewState";
import { FileChangesIcon } from "./FileChangesIcon";

export function ReviewDiffToolbar({
  reviewScope,
  onReviewScopeChange,
  layout,
  onLayoutChange,
  wordWrap,
  onWordWrapChange,
  allDiffsCollapsed,
  onToggleAllDiffs,
  isChangesOpen,
  onToggleChanges,
  branch,
  reviewCommentCount = 0,
  onReviewChanges,
}: {
  reviewScope: ReviewScope;
  onReviewScopeChange: (scope: ReviewScope) => void;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  wordWrap: boolean;
  onWordWrapChange: (enabled: boolean) => void;
  allDiffsCollapsed: boolean;
  onToggleAllDiffs: () => void;
  isChangesOpen: boolean;
  onToggleChanges: () => void;
  branch?: string;
  reviewCommentCount?: number;
  onReviewChanges?: () => void;
}) {
  const [showViewMenu, setShowViewMenu] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const closeViewMenu = useCallback(() => setShowViewMenu(false), []);
  useOutsideDismiss(viewMenuRef, showViewMenu, closeViewMenu);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 pb-3">
      <div className="flex min-w-0 items-center gap-2">
        {branch ? (
          <span className="inline-flex max-w-52 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5 text-xs font-medium text-zinc-300">
            <GitBranch size={13} className="shrink-0 text-emerald-400" />
            <span className="truncate">{branch}</span>
          </span>
        ) : null}
        <ReviewScopeDropdown
          value={reviewScope}
          onChange={onReviewScopeChange}
        />
      </div>
      <div className="flex items-center gap-2">
        <div ref={viewMenuRef} className="relative">
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
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onToggleAllDiffs();
                  setShowViewMenu(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-900 hover:text-white"
              >
                {allDiffsCollapsed ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronUp size={13} />
                )}
                {allDiffsCollapsed ? "Expand All Diffs" : "Collapse All Diffs"}
              </button>
            </div>
          ) : null}
        </div>
        {onReviewChanges ? (
          <button
            type="button"
            onClick={onReviewChanges}
            disabled={reviewCommentCount === 0}
            className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:border-sky-400/40 hover:bg-sky-500/15 hover:text-sky-200 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900/60 disabled:text-zinc-600"
          >
            Review changes ({reviewCommentCount})
          </button>
        ) : null}
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
          onClick={onToggleChanges}
          className={cn(
            "rounded-md p-1.5 transition-colors hover:bg-zinc-900 hover:text-white",
            isChangesOpen ? "bg-zinc-800 text-white" : "text-zinc-500",
          )}
          aria-label="Toggle file changes sidebar"
          aria-pressed={isChangesOpen}
          title="File changes"
        >
          <FileChangesIcon size={16} />
        </button>
      </div>
    </div>
  );
}
