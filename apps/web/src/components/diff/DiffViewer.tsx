import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  MessageSquareText,
  Plus,
  Rows3,
  SquareSplitHorizontal,
} from "lucide-react";
import type { DiffContent, DiffHunk, DiffLine as DiffLineType } from "@repo/shared-types";
import DiffLine from "./DiffLine";
import { DiffCodeText } from "./DiffCodeText";
import { resolveDiffLanguage } from "./resolveDiffLanguage";
import { useAnchorIndex, buildLineKey } from "../../lib/diff/useAnchorIndex";
import { useSelectionManager } from "../../lib/diff/useSelectionManager";
import { useAnnotationDispatcher } from "../../lib/diff/useAnnotationDispatcher";
import type {
  CreateReviewCommentInput,
  ReviewCommentDraft,
} from "../git/reviewComments";

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
  useFileSummaryHunkHeader?: boolean;
  hunkExpansionRequest?: {
    action: "collapse" | "expand";
    id: number;
  };
  onCreateReviewComment?: (input: CreateReviewCommentInput) => void;
  onDeleteReviewComment?: (commentId: string) => void;
}

interface SplitLineRow {
  kind: "line";
  key: string;
  rowKeys: string[];
  left: DiffLineType | null;
  right: DiffLineType | null;
}

type SplitRenderRow = SplitLineRow | CollapsedDiffRow;

interface VisibleDiffRow {
  kind: "line";
  key: string;
  line: DiffLineType;
  lineIndex: number;
}

interface CollapsedDiffRow {
  kind: "collapsed";
  key: string;
  hiddenLineCount: number;
}

type DiffRenderRow = VisibleDiffRow | CollapsedDiffRow;

interface HunkRenderPlan {
  hunkIndex: number;
  rows: DiffRenderRow[];
  selectableRowKeys: string[];
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
  useFileSummaryHunkHeader = false,
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

  const additions = useMemo(
    () =>
      diff.hunks.reduce(
        (sum, hunk) =>
          sum + hunk.lines.filter((line) => line.type === "added").length,
        0,
      ),
    [diff.hunks],
  );
  const language = useMemo(
    () => resolveDiffLanguage(diff.newPath || diff.oldPath),
    [diff.newPath, diff.oldPath],
  );
  const diffPath = diff.newPath || diff.oldPath || "Unknown file";
  const showFileSummaryHunkHeader = useFileSummaryHunkHeader || !showHeader;
  const deletions = useMemo(
    () =>
      diff.hunks.reduce(
        (sum, hunk) =>
          sum + hunk.lines.filter((line) => line.type === "deleted").length,
        0,
      ),
    [diff.hunks],
  );

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
            <div className="min-w-0">
              <p className="truncate text-sm font-mono text-zinc-200">
                {diff.newPath || diff.oldPath}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                {diff.isNewFile ? (
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                    New file
                  </span>
                ) : null}
                {diff.isDeleted ? (
                  <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">
                    Deleted file
                  </span>
                ) : null}
                <span className="text-emerald-400">+{additions}</span>
                <span className="text-red-400">-{deletions}</span>
              </div>
            </div>

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
              <div key={plan.hunkIndex} className="border-b border-zinc-800 last:border-b-0">
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
                  {showFileSummaryHunkHeader ? (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span className="truncate text-zinc-100">{diffPath}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-emerald-400">+{additions}</span>
                        <span className="text-red-400">-{deletions}</span>
                      </span>
                    </span>
                  ) : (
                    <span>{hunk.header}</span>
                  )}
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

interface StackedHunkViewProps {
  plan: HunkRenderPlan;
  language: string;
  wrap: boolean;
  canCreateReviewComment: boolean;
  selectedRowKeys: string[];
  annotationsByAnchor: Map<string, ReviewCommentDraft[]>;
  annotationCounts: Map<string, number>;
  onRowSelect: (
    rowKeys: string[],
    event: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
  ) => void;
  onOpenInlineComment: (rowKeys: string[]) => void;
  onAddAnnotation: (note: string) => void;
  onClearSelection: () => void;
  onReplyToAnnotation: (annotation: ReviewCommentDraft) => void;
  onResolveAnnotation: (annotationId: string) => void;
}

function StackedHunkView({
  plan,
  language,
  wrap,
  canCreateReviewComment,
  selectedRowKeys,
  annotationsByAnchor,
  annotationCounts,
  onRowSelect,
  onOpenInlineComment,
  onAddAnnotation,
  onClearSelection,
  onReplyToAnnotation,
  onResolveAnnotation,
}: StackedHunkViewProps) {
  const composerAnchor = getComposerAnchor(plan.selectableRowKeys, selectedRowKeys);

  return (
    <>
      {plan.rows.map((row) => {
        if (row.kind === "collapsed") {
          return <CollapsedLinesBanner key={row.key} count={row.hiddenLineCount} />;
        }

        const rowKey = row.key;
        const anchoredAnnotations = annotationsByAnchor.get(rowKey) ?? [];
        return (
          <Fragment key={rowKey}>
            <DiffLine
              line={row.line}
              hunksIndex={plan.hunkIndex}
              lineIndex={row.lineIndex}
              language={language}
              wrap={wrap}
              isSelected={selectedRowKeys.includes(rowKey)}
              annotationCount={annotationCounts.get(rowKey) ?? 0}
              onClick={(event) => onRowSelect([rowKey], event)}
              onAddComment={
                canCreateReviewComment
                  ? (event) => {
                      event.stopPropagation();
                      onOpenInlineComment([rowKey]);
                    }
                  : undefined
              }
            />
            {canCreateReviewComment && composerAnchor === rowKey ? (
              <InlineCommentComposer
                selectedCount={selectedRowKeys.length}
                onAddAnnotation={onAddAnnotation}
                onCancel={onClearSelection}
              />
            ) : null}
            {anchoredAnnotations.map((annotation) => (
              <InlineAnnotationCard
                key={annotation.id}
                annotation={annotation}
                onReply={() => onReplyToAnnotation(annotation)}
                onResolve={() => onResolveAnnotation(annotation.id)}
              />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

interface SplitHunkViewProps {
  plan: HunkRenderPlan;
  language: string;
  wrap: boolean;
  canCreateReviewComment: boolean;
  selectedRowKeys: string[];
  annotationsByAnchor: Map<string, ReviewCommentDraft[]>;
  annotationCounts: Map<string, number>;
  onRowSelect: (
    rowKeys: string[],
    event: React.MouseEvent<HTMLDivElement>,
  ) => void;
  onOpenInlineComment: (rowKeys: string[]) => void;
  onAddAnnotation: (note: string) => void;
  onClearSelection: () => void;
  onReplyToAnnotation: (annotation: ReviewCommentDraft) => void;
  onResolveAnnotation: (annotationId: string) => void;
}

function SplitHunkView({
  plan,
  language,
  wrap,
  canCreateReviewComment,
  selectedRowKeys,
  annotationsByAnchor,
  annotationCounts,
  onRowSelect,
  onOpenInlineComment,
  onAddAnnotation,
  onClearSelection,
  onReplyToAnnotation,
  onResolveAnnotation,
}: SplitHunkViewProps) {
  const rows = useMemo(() => buildSplitRows(plan.rows), [plan.rows]);
  const composerAnchor = getComposerAnchor(
    rows.map((row) => row.key),
    selectedRowKeys,
  );

  return (
    <div
      className={`grid divide-x divide-zinc-800 ${
        wrap
          ? "w-full grid-cols-2"
          : "min-w-[960px] w-full grid-cols-2"
      }`}
    >
      {rows.map((row) => {
        if (row.kind === "collapsed") {
          return <CollapsedLinesBanner key={row.key} count={row.hiddenLineCount} split />;
        }

        const isSelected = row.rowKeys.some((rowKey) => selectedRowKeys.includes(rowKey));
        const annotationCount = row.rowKeys.reduce(
          (sum, rowKey) => sum + (annotationCounts.get(rowKey) ?? 0),
          0,
        );
        const anchoredAnnotations = Array.from(
          new Map(
            row.rowKeys
              .flatMap((rowKey) => annotationsByAnchor.get(rowKey) ?? [])
              .map((annotation) => [annotation.id, annotation]),
          ).values(),
        );
        return (
          <Fragment key={row.key}>
            <SplitDiffCell
              line={row.left}
              side="left"
              language={language}
              wrap={wrap}
              isSelected={isSelected}
              annotationCount={annotationCount}
              onClick={(event) => onRowSelect(row.rowKeys, event)}
              onAddComment={
                canCreateReviewComment
                  ? (event) => {
                      event.stopPropagation();
                      onOpenInlineComment(row.rowKeys);
                    }
                  : undefined
              }
            />
            <SplitDiffCell
              line={row.right}
              side="right"
              language={language}
              wrap={wrap}
              isSelected={isSelected}
              annotationCount={annotationCount}
              onClick={(event) => onRowSelect(row.rowKeys, event)}
              onAddComment={
                canCreateReviewComment
                  ? (event) => {
                      event.stopPropagation();
                      onOpenInlineComment(row.rowKeys);
                    }
                  : undefined
              }
            />
            {canCreateReviewComment && composerAnchor === row.key ? (
              <div className="col-span-2 border-b border-zinc-900/80 bg-sky-500/12 px-6 py-5">
                <InlineCommentComposer
                  selectedCount={selectedRowKeys.length}
                  onAddAnnotation={onAddAnnotation}
                  onCancel={onClearSelection}
                />
              </div>
            ) : null}
            {anchoredAnnotations.map((annotation) => (
              <div
                key={annotation.id}
                className="col-span-2 border-b border-zinc-900/80 bg-black px-6 py-5"
              >
                <InlineAnnotationCard
                  annotation={annotation}
                  onReply={() => onReplyToAnnotation(annotation)}
                  onResolve={() => onResolveAnnotation(annotation.id)}
                />
              </div>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

interface SplitDiffCellProps {
  line: DiffLineType | null;
  side: "left" | "right";
  language: string;
  wrap: boolean;
  isSelected: boolean;
  annotationCount: number;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAddComment?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

function SplitDiffCell({
  line,
  side,
  language,
  wrap,
  isSelected,
  annotationCount,
  onClick,
  onAddComment,
}: SplitDiffCellProps) {
  if (!line) {
    return (
      <div
        className={`min-h-8 border-b border-zinc-900/80 bg-black/60 ${
          isSelected ? "bg-sky-500/10" : ""
        }`}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
      />
    );
  }

  const background =
    line.type === "added"
      ? "bg-emerald-500/16"
      : line.type === "deleted"
        ? "bg-rose-500/16"
        : "bg-black";
  const textColor =
    line.type === "added"
      ? "text-emerald-200"
      : line.type === "deleted"
        ? "text-rose-200"
        : "text-zinc-300";
  const borderColor =
    line.type === "added"
      ? "border-l-emerald-400"
      : line.type === "deleted"
        ? "border-l-rose-400"
        : "border-l-transparent";
  const lineNumber = side === "left" ? line.oldLineNumber : line.newLineNumber;

  return (
    <div
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className={`group relative flex min-h-8 min-w-full border-b border-l-2 border-zinc-900/80 font-mono text-sm ${
        isSelected ? "ring-1 ring-inset ring-sky-500/50" : ""
      } ${background} ${borderColor}`}
    >
      <div className="absolute left-0 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        {onAddComment ? (
          <button
            type="button"
            onClick={onAddComment}
            className={`flex h-6 w-6 items-center justify-center rounded-md bg-sky-500 text-white shadow-[0_0_0_1px_rgba(125,211,252,0.35)] transition-opacity hover:bg-sky-400 ${
              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            aria-label="Add comment"
          >
            <Plus size={14} />
          </button>
        ) : null}
      </div>
      <div className="w-12 shrink-0 bg-zinc-900/50 px-2 py-1 text-right text-xs text-zinc-500">
        {lineNumber ?? ""}
      </div>
      <div className={`flex-1 px-3 py-1 ${textColor}`}>
        <DiffCodeText content={line.content} language={language} wrap={wrap} />
      </div>
      {annotationCount > 0 ? (
        <div className="mr-3 flex items-center text-[10px] uppercase tracking-[0.16em] text-amber-300">
          {annotationCount}
        </div>
      ) : null}
    </div>
  );
}

function CollapsedLinesBanner({
  count,
  split = false,
}: {
  count: number;
  split?: boolean;
}) {
  return (
    <div
      className={`border-b border-zinc-900/80 bg-zinc-950/90 px-4 py-2 text-center font-mono text-xs text-zinc-500 ${
        split ? "col-span-2" : ""
      }`}
      aria-label={`${count} unmodified lines collapsed`}
    >
      {count} unmodified line{count === 1 ? "" : "s"}
    </div>
  );
}

interface InlineCommentComposerProps {
  selectedCount: number;
  onAddAnnotation: (note: string) => void;
  onCancel: () => void;
}

function InlineCommentComposer({
  selectedCount,
  onAddAnnotation,
  onCancel,
}: InlineCommentComposerProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const note = draft.trim();
    if (!note) {
      return;
    }
    onAddAnnotation(note);
    setDraft("");
  };

  return (
    <div className="border-b border-zinc-900/80 bg-sky-500/12 px-6 py-5">
      <div className="mx-auto max-w-3xl rounded-2xl border border-red-500/30 bg-[#111112] p-4 shadow-[0_0_0_1px_rgba(239,68,68,0.08)]">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">
            You
          </div>
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">
            {selectedCount} selected row{selectedCount === 1 ? "" : "s"}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Leave a comment"
          className="min-h-24 w-full rounded-xl border border-red-500/30 bg-black/70 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-red-400/50 focus:outline-none"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
            }
          }}
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!draft.trim()}
            className="rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            Comment
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface InlineAnnotationCardProps {
  annotation: ReviewCommentDraft;
  onReply: () => void;
  onResolve: () => void;
}

function InlineAnnotationCard({
  annotation,
  onReply,
  onResolve,
}: InlineAnnotationCardProps) {
  return (
    <div className="border-b border-zinc-900/80 bg-black px-6 py-5">
      <div className="mx-auto max-w-3xl rounded-2xl border border-red-500/30 bg-[#111112] p-4 shadow-[0_0_0_1px_rgba(239,68,68,0.08)]">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">
            You
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              <span className="font-medium text-white">You</span>
              <span className="text-zinc-500">now</span>
            </div>
            <div className="mt-2 text-sm leading-6 text-zinc-200">{annotation.note}</div>
            <div className="mt-4 flex items-center gap-4 text-sm">
              <button
                type="button"
                onClick={onReply}
                className="inline-flex items-center gap-2 text-sky-300 transition-colors hover:text-sky-200"
              >
                <MessageSquareText size={14} />
                Add reply...
              </button>
              <button
                type="button"
                onClick={onResolve}
                className="text-sky-300 transition-colors hover:text-sky-200"
              >
                Resolve
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function getComposerAnchor(visibleRowKeys: string[], selectedRowKeys: string[]): string | null {
  if (selectedRowKeys.length === 0) {
    return null;
  }

  const visibleSelection = visibleRowKeys.filter((rowKey) => selectedRowKeys.includes(rowKey));
  return visibleSelection[visibleSelection.length - 1] ?? null;
}

function collectCommentedRowKeys(reviewComments: ReviewCommentDraft[]): Set<string> {
  return new Set(
    reviewComments.flatMap((comment) =>
      comment.anchors.map((anchor) => anchor.rowKey),
    ),
  );
}

function buildRenderPlans(
  diff: DiffContent,
  commentedRowKeys: Set<string>,
): HunkRenderPlan[] {
  return diff.hunks.map((hunk, hunkIndex) =>
    buildHunkRenderPlan(hunk, hunkIndex, commentedRowKeys),
  );
}

function buildHunkRenderPlan(
  hunk: DiffHunk,
  hunkIndex: number,
  commentedRowKeys: Set<string>,
): HunkRenderPlan {
  const ranges = buildVisibleRanges(hunk.lines, hunkIndex, commentedRowKeys);
  const rows = buildRenderRows(hunk.lines, hunkIndex, ranges);
  const selectableRowKeys = rows.flatMap((row) =>
    row.kind === "line" ? [row.key] : [],
  );
  return { hunkIndex, rows, selectableRowKeys };
}

function buildVisibleRanges(
  lines: DiffLineType[],
  hunkIndex: number,
  commentedRowKeys: Set<string>,
) {
  const contextLineCount = 3;
  const visibleIndexes = lines.flatMap((line, lineIndex) => {
    const rowKey = buildLineKey(hunkIndex, lineIndex);
    return line.type !== "unchanged" || commentedRowKeys.has(rowKey)
      ? [lineIndex]
      : [];
  });

  const ranges = visibleIndexes.map((lineIndex) => ({
    start: Math.max(0, lineIndex - contextLineCount),
    end: Math.min(lines.length - 1, lineIndex + contextLineCount),
  }));

  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  return ranges.reduce<Array<{ start: number; end: number }>>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
      return merged;
    }

    previous.end = Math.max(previous.end, range.end);
    return merged;
  }, []);
}

function buildRenderRows(
  lines: DiffLineType[],
  hunkIndex: number,
  ranges: Array<{ start: number; end: number }>,
): DiffRenderRow[] {
  if (ranges.length === 0) {
    return [{ kind: "collapsed", key: `${hunkIndex}:all-collapsed`, hiddenLineCount: lines.length }];
  }

  const rows: DiffRenderRow[] = [];
  let nextLineIndex = 0;
  ranges.forEach((range, rangeIndex) => {
    appendCollapsedRows(rows, hunkIndex, nextLineIndex, range.start, rangeIndex);
    appendVisibleRows(rows, lines, hunkIndex, range);
    nextLineIndex = range.end + 1;
  });
  appendCollapsedRows(rows, hunkIndex, nextLineIndex, lines.length, ranges.length);
  return rows;
}

function appendCollapsedRows(
  rows: DiffRenderRow[],
  hunkIndex: number,
  start: number,
  end: number,
  position: number,
) {
  const hiddenLineCount = end - start;
  if (hiddenLineCount <= 0) {
    return;
  }

  rows.push({
    kind: "collapsed",
    key: `${hunkIndex}:collapsed:${position}:${start}-${end}`,
    hiddenLineCount,
  });
}

function appendVisibleRows(
  rows: DiffRenderRow[],
  lines: DiffLineType[],
  hunkIndex: number,
  range: { start: number; end: number },
) {
  for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) {
      continue;
    }

    rows.push({
      kind: "line",
      key: buildLineKey(hunkIndex, lineIndex),
      line,
      lineIndex,
    });
  }
}

function buildSplitRows(renderRows: DiffRenderRow[]): SplitRenderRow[] {
  const rows: SplitRenderRow[] = [];

  for (let index = 0; index < renderRows.length;) {
    const row = renderRows[index];
    if (!row) {
      return rows;
    }

    if (row.kind === "collapsed") {
      rows.push(row);
      index += 1;
      continue;
    }

    if (row.line.type === "unchanged") {
      rows.push({
        kind: "line",
        key: row.key,
        rowKeys: [row.key],
        left: row.line,
        right: row.line,
      });
      index += 1;
      continue;
    }

    const deleted: VisibleDiffRow[] = [];
    const added: VisibleDiffRow[] = [];
    while (index < renderRows.length) {
      const current = renderRows[index];
      if (!current || current.kind === "collapsed" || current.line.type === "unchanged") {
        break;
      }
      if (current.line.type === "deleted") {
        deleted.push(current);
      }
      if (current.line.type === "added") {
        added.push(current);
      }
      index += 1;
    }

    const chunkSize = Math.max(deleted.length, added.length);
    for (let rowIndex = 0; rowIndex < chunkSize; rowIndex += 1) {
      const leftEntry = deleted[rowIndex] ?? null;
      const rightEntry = added[rowIndex] ?? null;
      const rowKeys = [leftEntry, rightEntry]
        .filter((entry): entry is VisibleDiffRow => entry !== null)
        .map((entry) => entry.key);

      rows.push({
        kind: "line",
        key: rowKeys[0] ?? `split-empty-${index}-${rowIndex}`,
        rowKeys,
        left: leftEntry?.line ?? null,
        right: rightEntry?.line ?? null,
      });
    }
  }

  return rows;
}
