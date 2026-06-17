import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Rows3,
  SquareSplitHorizontal,
} from "lucide-react";
import type { DiffContent, DiffHunk } from "@repo/shared-types";
import { resolveDiffLanguage } from "./resolveDiffLanguage";
import { useAnchorIndex } from "../../lib/diff/useAnchorIndex";
import { useSelectionManager } from "../../lib/diff/useSelectionManager";
import { useAnnotationDispatcher } from "../../lib/diff/useAnnotationDispatcher";
import type {
  CreateReviewCommentInput,
  ReviewCommentDraft,
} from "../git/reviewComments";
import {
  buildRenderPlans,
  collectCommentedRowKeys,
} from "./diffRenderPlan";
import { countDiffAdditions, countDiffDeletions } from "./diffStats";
import { DiffFileSummary } from "./DiffFileSummary";
import { SplitHunkView } from "./SplitHunkView";
import { StackedHunkView } from "./StackedHunkView";

interface DiffViewerProps {
  diff: DiffContent;
  className?: string;
  reviewComments?: ReviewCommentDraft[];
  diffFingerprint?: string | null;
  layout?: "stacked" | "split";
  onLayoutChange?: (layout: "stacked" | "split") => void;
  wordWrap?: boolean;
  onWordWrapChange?: (enabled: boolean) => void;
  showHeader?: boolean;
  hunkExpansionRequest?: {
    action: "collapse" | "expand";
    id: number;
  };
  onCreateReviewComment?: (input: CreateReviewCommentInput) => void;
  onDeleteReviewComment?: (commentId: string) => void;
}

export function DiffViewer({
  diff,
  className = "",
  reviewComments = [],
  diffFingerprint = null,
  layout: controlledLayout,
  onLayoutChange,
  wordWrap: controlledWordWrap,
  onWordWrapChange,
  showHeader = true,
  hunkExpansionRequest,
  onCreateReviewComment,
  onDeleteReviewComment,
}: DiffViewerProps) {
  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(
    new Set(diff.hunks.map((_: DiffHunk, index: number) => index)),
  );
  const [internalLayout, setInternalLayout] = useState<"stacked" | "split">("stacked");
  const [internalWordWrap, setInternalWordWrap] = useState(true);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const layout = controlledLayout ?? internalLayout;
  const wordWrap = controlledWordWrap ?? internalWordWrap;
  const canChangeLayout = controlledLayout === undefined || onLayoutChange !== undefined;
  const setLayout = (nextLayout: "stacked" | "split") => {
    if (onLayoutChange) {
      onLayoutChange(nextLayout);
      return;
    }

    if (controlledLayout === undefined) {
      setInternalLayout(nextLayout);
    }
  };

  const setWordWrap = (value: boolean | ((prev: boolean) => boolean)) => {
    const nextValue = typeof value === "function" ? value(wordWrap) : value;
    if (onWordWrapChange) {
      onWordWrapChange(nextValue);
      return;
    }

    if (controlledWordWrap === undefined) {
      setInternalWordWrap(nextValue);
    }
  };
  const commentedRowKeys = useMemo(() => collectCommentedRowKeys(reviewComments), [reviewComments]);
  const renderPlans = useMemo(
    () => buildRenderPlans(diff, commentedRowKeys),
    [commentedRowKeys, diff],
  );
  const visibleRowOrder = useMemo(
    () => renderPlans.flatMap((plan) => plan.selectableRowKeys),
    [renderPlans],
  );
  const { rowOrder, lineLookup } = useAnchorIndex(diff, visibleRowOrder);
  const {
    selectedRowKeys,
    handleRowSelection,
    openInlineComment,
    clearSelection,
    restoreAnnotationSelection,
  } = useSelectionManager({ rowOrder });
  const {
    canCreateReviewComment,
    annotationCounts,
    annotationsByAnchor,
    addAnnotation,
    resolveAnnotation,
  } = useAnnotationDispatcher({
    diff,
    reviewComments,
    diffFingerprint,
    onCreateReviewComment,
    onDeleteReviewComment,
    selectedRowKeys,
    lineLookup,
    clearSelection,
  });

  const additions = useMemo(() => countDiffAdditions(diff), [diff]);
  const language = useMemo(
    () => resolveDiffLanguage(diff.newPath || diff.oldPath),
    [diff.newPath, diff.oldPath],
  );
  const diffPath = diff.newPath || diff.oldPath || "Unknown file";
  const deletions = useMemo(() => countDiffDeletions(diff), [diff]);

  const toggleHunk = (index: number) => {
    setExpandedHunks((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!hunkExpansionRequest) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      setExpandedHunks(
        hunkExpansionRequest.action === "expand"
          ? new Set(diff.hunks.map((_: DiffHunk, index: number) => index))
          : new Set(),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [diff.hunks, hunkExpansionRequest]);

  return (
    <div className={`flex h-full bg-black ${className}`}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg">
        {showHeader ? (
          <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <DiffFileSummary
                additions={additions}
                deletions={deletions}
                diffPath={diffPath}
                isDeleted={diff.isDeleted}
                isNewFile={diff.isNewFile}
              />

              <div className="flex items-center gap-2 text-xs">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowViewMenu((previous) => !previous)}
                    className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-1 text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
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
                          setWordWrap((previous) => !previous);
                          setShowViewMenu(false);
                        }}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-900 hover:text-white"
                      >
                        {wordWrap ? "Disable word wrap" : "Enable word wrap"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setLayout("split")}
                  disabled={!canChangeLayout}
                  className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:border-zinc-900 disabled:text-zinc-700 ${
                    layout === "split"
                      ? "border-zinc-600 bg-zinc-800 text-white"
                      : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <SquareSplitHorizontal size={14} />
                  Split
                </button>
                <button
                  type="button"
                  onClick={() => setLayout("stacked")}
                  disabled={!canChangeLayout}
                  className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:border-zinc-900 disabled:text-zinc-700 ${
                    layout === "stacked"
                      ? "border-zinc-600 bg-zinc-800 text-white"
                      : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <Rows3 size={14} />
                  Stacked
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {!showHeader ? (
          <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
            <DiffFileSummary
              additions={additions}
              deletions={deletions}
              diffPath={diffPath}
              isDeleted={diff.isDeleted}
              isNewFile={diff.isNewFile}
            />
          </div>
        ) : null}

        <div className="flex-1 overflow-x-auto overflow-y-auto">
          {diff.hunks.length === 0 ? (
            <div className="p-4 text-sm text-zinc-500">No changes</div>
          ) : (
            renderPlans.map((plan) => {
              const hunk = diff.hunks[plan.hunkIndex];
              if (!hunk) {
                return null;
              }

              return (
                <div
                  key={plan.hunkIndex}
                  className="border-b border-zinc-800 last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => toggleHunk(plan.hunkIndex)}
                    className="flex w-full items-center gap-2 bg-zinc-900 px-4 py-2 font-mono text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    {expandedHunks.has(plan.hunkIndex) ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                    <span>{hunk.header || `Hunk ${plan.hunkIndex + 1}`}</span>
                  </button>

                  {expandedHunks.has(plan.hunkIndex) ? (
                    <div className="border-t border-zinc-800">
                      {layout === "stacked" ? (
                        <StackedHunkView
                          plan={plan}
                          language={language}
                          wrap={wordWrap}
                          canCreateReviewComment={canCreateReviewComment}
                          selectedRowKeys={selectedRowKeys}
                          annotationsByAnchor={annotationsByAnchor}
                          annotationCounts={annotationCounts}
                          onRowSelect={handleRowSelection}
                          onOpenInlineComment={openInlineComment}
                          onAddAnnotation={addAnnotation}
                          onClearSelection={clearSelection}
                          onReplyToAnnotation={restoreAnnotationSelection}
                          onResolveAnnotation={resolveAnnotation}
                        />
                      ) : (
                        <SplitHunkView
                          plan={plan}
                          language={language}
                          wrap={wordWrap}
                          canCreateReviewComment={canCreateReviewComment}
                          selectedRowKeys={selectedRowKeys}
                          annotationsByAnchor={annotationsByAnchor}
                          annotationCounts={annotationCounts}
                          onRowSelect={handleRowSelection}
                          onOpenInlineComment={openInlineComment}
                          onAddAnnotation={addAnnotation}
                          onClearSelection={clearSelection}
                          onReplyToAnnotation={restoreAnnotationSelection}
                          onResolveAnnotation={resolveAnnotation}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
