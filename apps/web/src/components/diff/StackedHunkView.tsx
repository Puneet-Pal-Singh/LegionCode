import { Fragment } from "react";
import DiffLine from "./DiffLine";
import { CollapsedLinesBanner } from "./CollapsedLinesBanner";
import { InlineAnnotationCard } from "./InlineAnnotationCard";
import { InlineCommentComposer } from "./InlineCommentComposer";
import { getComposerAnchor } from "./diffSelection";
import type { HunkRenderPlan } from "./diffRenderPlan";
import type { ReviewCommentDraft } from "../git/reviewComments";
import { useCollapsedDiffRows } from "./useCollapsedDiffRows";

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

export function StackedHunkView({
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
  const collapsedRows = useCollapsedDiffRows();

  return (
    <>
      {plan.rows.map((row, rowIndex) => {
        if (row.kind === "collapsed") {
          const expanded = collapsedRows.isExpanded(row.key);
          return (
            <Fragment key={row.key}>
            <CollapsedLinesBanner
              count={row.hiddenLineCount}
              onToggle={() => collapsedRows.toggleExpanded(row.key)}
              expanded={expanded}
              placement={getCollapsedRowPlacement(rowIndex, plan.rows.length)}
            />
            {expanded
              ? row.lines.map((hiddenRow) => (
                  <DiffLine
                    key={hiddenRow.key}
                    line={hiddenRow.line}
                    hunksIndex={plan.hunkIndex}
                    lineIndex={hiddenRow.lineIndex}
                    language={language}
                    wrap={wrap}
                    isSelected={selectedRowKeys.includes(hiddenRow.key)}
                    annotationCount={0}
                    onClick={(event) => onRowSelect([hiddenRow.key], event)}
                  />
                ))
              : null}
            </Fragment>
          );
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

function getCollapsedRowPlacement(
  rowIndex: number,
  rowCount: number,
): "start" | "middle" | "end" {
  if (rowIndex === 0) {
    return "start";
  }
  return rowIndex === rowCount - 1 ? "end" : "middle";
}
