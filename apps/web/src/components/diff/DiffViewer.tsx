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
import type {
  CreateReviewCommentInput,
  ReviewCommentAnchor,
  ReviewCommentDraft,
  ReviewCommentSelectionMode,
  ReviewCommentSide,
} from "../git/reviewComments";
import { normalizeLinePreview } from "../git/reviewComments";

interface DiffViewerProps {
  diff: DiffContent;
  className?: string;
  reviewComments?: ReviewCommentDraft[];
  diffFingerprint?: string | null;
  onCreateReviewComment?: (input: CreateReviewCommentInput) => void;
  onDeleteReviewComment?: (commentId: string) => void;
}

interface SplitRow {
  key: string;
  rowKeys: string[];
  left: DiffLineType | null;
  right: DiffLineType | null;
}

export function DiffViewer({
  diff,
  className = "",
  reviewComments = [],
  diffFingerprint = null,
  onCreateReviewComment,
  onDeleteReviewComment,
}: DiffViewerProps) {
  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(
    new Set(diff.hunks.map((_: DiffHunk, index: number) => index)),
  );
  const [layout, setLayout] = useState<"stacked" | "split">("stacked");
  const [wordWrap, setWordWrap] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const canCreateReviewComment = Boolean(diffFingerprint && onCreateReviewComment);
  const lineLookup = useMemo(() => buildLineLookup(diff), [diff]);

  const rowOrder = useMemo(() => {
    const keys: string[] = [];
    diff.hunks.forEach((hunk, hunkIndex) => {
      hunk.lines.forEach((_, lineIndex) => {
        keys.push(buildLineKey(hunkIndex, lineIndex));
      });
    });
    return keys;
  }, [diff.hunks]);

  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    reviewComments.forEach((annotation) => {
      annotation.anchors.forEach((anchor) => {
        const rowKey = anchor.rowKey;
        counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1);
      });
    });
    return counts;
  }, [reviewComments]);

  const annotationsByAnchor = useMemo(() => {
    const anchored = new Map<string, ReviewCommentDraft[]>();
    reviewComments.forEach((annotation) => {
      const anchorKey = annotation.primaryAnchor.rowKey;
      if (!anchorKey) {
        return;
      }
      const existing = anchored.get(anchorKey) ?? [];
      existing.push(annotation);
      anchored.set(anchorKey, existing);
    });
    return anchored;
  }, [reviewComments]);

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

  const handleRowSelection = (
    rowKeys: string[],
    event: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
  ) => {
    const firstRowKey = rowKeys[0] ?? null;
    const lastRowKey = rowKeys[rowKeys.length - 1] ?? null;
    if (!firstRowKey || !lastRowKey) {
      return;
    }

    if (event.shiftKey && selectionAnchor) {
      const anchorIndex = rowOrder.indexOf(selectionAnchor);
      const targetStartIndex = rowOrder.indexOf(firstRowKey);
      const targetEndIndex = rowOrder.indexOf(lastRowKey);
      if (
        anchorIndex >= 0 &&
        targetStartIndex >= 0 &&
        targetEndIndex >= 0
      ) {
        const start = Math.min(anchorIndex, targetStartIndex);
        const end = Math.max(anchorIndex, targetEndIndex);
        setSelectedRowKeys(rowOrder.slice(start, end + 1));
        return;
      }
    }

    setSelectionAnchor(firstRowKey);
    setSelectedRowKeys(rowKeys);
  };

  const addAnnotation = (note: string) => {
    const trimmedNote = note.trim();
    if (
      !trimmedNote ||
      selectedRowKeys.length === 0 ||
      !canCreateReviewComment ||
      !diffFingerprint ||
      !onCreateReviewComment
    ) {
      return;
    }

    const anchors = selectedRowKeys
      .map((rowKey) => lineLookup.get(rowKey))
      .filter((anchor): anchor is ReviewCommentAnchor => anchor !== undefined);
    const primaryAnchor = anchors[anchors.length - 1];
    if (!primaryAnchor) {
      return;
    }

    const selectionMode: ReviewCommentSelectionMode =
      anchors.length > 1 ? "range" : "single";
    onCreateReviewComment({
      filePath: diff.newPath || diff.oldPath,
      line:
        primaryAnchor.newLineNumber ??
        primaryAnchor.oldLineNumber ??
        0,
      side: normalizePrimarySide(primaryAnchor.side),
      note: trimmedNote,
      linePreview: primaryAnchor.linePreview,
      anchors,
      primaryAnchor,
      selectionMode,
      diffFingerprint,
    });
    clearSelection();
  };

  const openInlineComment = (rowKeys: string[]) => {
    const firstRowKey = rowKeys[0] ?? null;
    if (!firstRowKey) {
      return;
    }

    setSelectionAnchor(firstRowKey);
    setSelectedRowKeys(rowKeys);
  };

  const clearSelection = () => {
    setSelectionAnchor(null);
    setSelectedRowKeys([]);
  };

  const restoreAnnotationSelection = (annotation: ReviewCommentDraft) => {
    const anchorKey = annotation.anchors[0]?.rowKey ?? null;
    setSelectionAnchor(anchorKey);
    setSelectedRowKeys(annotation.anchors.map((anchor) => anchor.rowKey));
  };

  const resolveAnnotation = (annotationId: string) => {
    onDeleteReviewComment?.(annotationId);
  };

  return (
    <div className={`flex h-full bg-black ${className}`}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg">
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
                <span>{diff.hunks.length} hunks</span>
                <span>{reviewComments.length} notes</span>
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
                className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 transition-colors ${
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
                className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 transition-colors ${
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

        <div className="flex-1 overflow-x-auto overflow-y-auto">
          {diff.hunks.length === 0 ? (
            <div className="p-4 text-sm text-zinc-500">No changes</div>
          ) : (
            diff.hunks.map((hunk, hunkIndex) => (
              <div key={hunkIndex} className="border-b border-zinc-800 last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleHunk(hunkIndex)}
                  className="flex w-full items-center gap-2 bg-zinc-900 px-4 py-2 font-mono text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  {expandedHunks.has(hunkIndex) ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}
                  <span>{hunk.header}</span>
                </button>

                {expandedHunks.has(hunkIndex) ? (
                  <div className="border-t border-zinc-800">
                    {layout === "stacked" ? (
                      <StackedHunkView
                        hunk={hunk}
                        hunkIndex={hunkIndex}
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
                        hunk={hunk}
                        hunkIndex={hunkIndex}
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
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface StackedHunkViewProps {
  hunk: DiffHunk;
  hunkIndex: number;
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
  hunk,
  hunkIndex,
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
  const hunkRowKeys = hunk.lines.map((_, lineIndex) => buildLineKey(hunkIndex, lineIndex));
  const composerAnchor = getComposerAnchor(hunkRowKeys, selectedRowKeys);

  return (
    <>
      {hunk.lines.map((line, lineIndex) => {
        const rowKey = buildLineKey(hunkIndex, lineIndex);
        const anchoredAnnotations = annotationsByAnchor.get(rowKey) ?? [];
        return (
          <Fragment key={rowKey}>
            <DiffLine
              line={line}
              hunksIndex={hunkIndex}
              lineIndex={lineIndex}
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
  hunk: DiffHunk;
  hunkIndex: number;
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
  hunk,
  hunkIndex,
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
  const rows = useMemo(() => buildSplitRows(hunk.lines, hunkIndex), [hunk.lines, hunkIndex]);
  const composerAnchor = getComposerAnchor(
    rows.map((row) => row.key),
    selectedRowKeys,
  );

  return (
    <div
      className={`grid divide-x divide-zinc-800 ${
        wrap
          ? "w-full grid-cols-2"
          : "min-w-full w-max grid-cols-[max-content_max-content]"
      }`}
    >
      {rows.map((row) => {
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
        wrap ? "w-full" : "w-max"
      } ${
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

function buildLineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

function buildLineLookup(diff: DiffContent): Map<string, ReviewCommentAnchor> {
  const lookup = new Map<string, ReviewCommentAnchor>();

  diff.hunks.forEach((hunk, hunkIndex) => {
    hunk.lines.forEach((line, lineIndex) => {
      const rowKey = buildLineKey(hunkIndex, lineIndex);
      lookup.set(rowKey, {
        hunkIndex,
        lineIndex,
        rowKey,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        side: deriveReviewCommentSide(line),
        linePreview: normalizeLinePreview(line.content),
      });
    });
  });

  return lookup;
}

function deriveReviewCommentSide(line: DiffLineType): ReviewCommentSide {
  if (line.type === "deleted") {
    return "left";
  }
  if (line.type === "added") {
    return "right";
  }
  return "both";
}

function normalizePrimarySide(side: ReviewCommentSide): ReviewCommentSide {
  if (side === "both") {
    return "right";
  }
  return side;
}

function buildSplitRows(lines: DiffLineType[], hunkIndex: number): SplitRow[] {
  const rows: SplitRow[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line) {
      break;
    }

    if (line.type === "unchanged") {
      const rowKey = buildLineKey(hunkIndex, index);
      rows.push({
        key: rowKey,
        rowKeys: [rowKey],
        left: line,
        right: line,
      });
      index += 1;
      continue;
    }

    const deleted: Array<{ line: DiffLineType; lineIndex: number }> = [];
    const added: Array<{ line: DiffLineType; lineIndex: number }> = [];
    while (index < lines.length && lines[index]?.type !== "unchanged") {
      const current = lines[index];
      if (!current) {
        break;
      }
      if (current.type === "deleted") {
        deleted.push({ line: current, lineIndex: index });
      }
      if (current.type === "added") {
        added.push({ line: current, lineIndex: index });
      }
      index += 1;
    }

    const chunkSize = Math.max(deleted.length, added.length);
    for (let rowIndex = 0; rowIndex < chunkSize; rowIndex += 1) {
      const leftEntry = deleted[rowIndex] ?? null;
      const rightEntry = added[rowIndex] ?? null;
      const rowKeys = [leftEntry, rightEntry]
        .filter((entry): entry is { line: DiffLineType; lineIndex: number } => entry !== null)
        .map((entry) => buildLineKey(hunkIndex, entry.lineIndex));

      rows.push({
        key: rowKeys[0] ?? buildLineKey(hunkIndex, index),
        rowKeys,
        left: leftEntry?.line ?? null,
        right: rightEntry?.line ?? null,
      });
    }
  }

  return rows;
}
