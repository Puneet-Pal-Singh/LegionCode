import { Fragment } from "react";
import DiffLine from "./DiffLine";
import { CollapsedLinesBanner } from "./CollapsedLinesBanner";
import { InlineAnnotationCard } from "./InlineAnnotationCard";
import { InlineCommentComposer } from "./InlineCommentComposer";
import { getComposerAnchor } from "./diffSelection";
import type { HunkRenderPlan } from "./diffRenderPlan";
import type { ReviewCommentDraft } from "../git/reviewComments";

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

  return (
    <>
      {plan.rows.map((row) => {
        if (row.kind === "collapsed") {
          return (
            <CollapsedLinesBanner
              key={row.key}
              count={row.hiddenLineCount}
            />
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
