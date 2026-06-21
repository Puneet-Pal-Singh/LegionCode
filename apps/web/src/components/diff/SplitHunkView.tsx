import { Fragment, useMemo } from "react";
import { CollapsedLinesBanner } from "./CollapsedLinesBanner";
import { InlineAnnotationCard } from "./InlineAnnotationCard";
import { InlineCommentComposer } from "./InlineCommentComposer";
import { SplitDiffCell } from "./SplitDiffCell";
import { getComposerAnchor } from "./diffSelection";
import type { HunkRenderPlan } from "./diffRenderPlan";
import { buildSplitRows } from "./splitRows";
import type { ReviewCommentDraft } from "../git/reviewComments";
import { useCollapsedDiffRows } from "./useCollapsedDiffRows";

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
  onDeleteAnnotation: (annotationId: string) => void;
}

export function SplitHunkView({
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
  onDeleteAnnotation,
}: SplitHunkViewProps) {
  const rows = useMemo(() => buildSplitRows(plan.rows), [plan.rows]);
  const composerAnchor = getComposerAnchor(
    rows.map((row) => row.key),
    selectedRowKeys,
  );
  const collapsedRows = useCollapsedDiffRows();

  return (
    <div
      className={`grid divide-x divide-zinc-800 ${
        wrap ? "w-full grid-cols-2" : "min-w-[960px] w-full grid-cols-2"
      }`}
    >
      {rows.map((row, rowIndex) => {
        if (row.kind === "collapsed") {
          const expanded = collapsedRows.isExpanded(row.key);
          return (
            <Fragment key={row.key}>
              <CollapsedLinesBanner
                count={row.hiddenLineCount}
                split
                onToggle={() => collapsedRows.toggleExpanded(row.key)}
                expanded={expanded}
                placement={getCollapsedRowPlacement(rowIndex, rows.length)}
              />
              {expanded
                ? row.lines.flatMap((hiddenRow) => [
                    <SplitDiffCell
                      key={`${hiddenRow.key}:left`}
                      line={hiddenRow.line}
                      side="left"
                      language={language}
                      wrap={wrap}
                      isSelected={selectedRowKeys.includes(hiddenRow.key)}
                      annotationCount={0}
                      onClick={(event) => onRowSelect([hiddenRow.key], event)}
                    />,
                    <SplitDiffCell
                      key={`${hiddenRow.key}:right`}
                      line={hiddenRow.line}
                      side="right"
                      language={language}
                      wrap={wrap}
                      isSelected={selectedRowKeys.includes(hiddenRow.key)}
                      annotationCount={0}
                      onClick={(event) => onRowSelect([hiddenRow.key], event)}
                    />,
                  ])
                : null}
            </Fragment>
          );
        }

        const rowSelection = getSplitRowSelection({
          rowKeys: row.rowKeys,
          selectedRowKeys,
          annotationCounts,
          annotationsByAnchor,
        });
        return (
          <Fragment key={row.key}>
            <SplitDiffCell
              line={row.left}
              side="left"
              language={language}
              wrap={wrap}
              isSelected={rowSelection.isSelected}
              annotationCount={rowSelection.annotationCount}
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
              isSelected={rowSelection.isSelected}
              annotationCount={rowSelection.annotationCount}
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
            {rowSelection.anchoredAnnotations.map((annotation) => (
              <div
                key={annotation.id}
                className="col-span-2 border-b border-zinc-900/80 bg-black px-6 py-5"
              >
                <InlineAnnotationCard
                  annotation={annotation}
                  onReply={() => onReplyToAnnotation(annotation)}
                  onResolve={() => onResolveAnnotation(annotation.id)}
                  onDelete={() => onDeleteAnnotation(annotation.id)}
                />
              </div>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function getCollapsedRowPlacement(
  rowIndex: number,
  rowCount: number,
): "start" | "middle" | "end" {
  if (rowIndex === 0) {
    return "start";
  }
  return rowIndex === rowCount - 1 ? "end" : "middle";
}

function getSplitRowSelection({
  rowKeys,
  selectedRowKeys,
  annotationCounts,
  annotationsByAnchor,
}: {
  rowKeys: string[];
  selectedRowKeys: string[];
  annotationCounts: Map<string, number>;
  annotationsByAnchor: Map<string, ReviewCommentDraft[]>;
}) {
  const isSelected = rowKeys.some((rowKey) => selectedRowKeys.includes(rowKey));
  const annotationCount = rowKeys.reduce(
    (sum, rowKey) => sum + (annotationCounts.get(rowKey) ?? 0),
    0,
  );
  const anchoredAnnotations = Array.from(
    new Map(
      rowKeys
        .flatMap((rowKey) => annotationsByAnchor.get(rowKey) ?? [])
        .map((annotation) => [annotation.id, annotation]),
    ).values(),
  );

  return { isSelected, annotationCount, anchoredAnnotations };
}
