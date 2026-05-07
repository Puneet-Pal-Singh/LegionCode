import { useMemo } from "react";
import type { DiffContent, DiffLine as DiffLineType } from "@repo/shared-types";
import type {
  ReviewCommentAnchor,
  ReviewCommentSide,
} from "../../components/git/reviewComments";
import { normalizeLinePreview } from "../../components/git/reviewComments";

export interface AnchorIndexState {
  rowOrder: string[];
  lineLookup: Map<string, ReviewCommentAnchor>;
}

export function useAnchorIndex(
  diff: DiffContent,
  visibleRowOrder?: string[],
): AnchorIndexState {
  const rawRowOrder = useMemo(() => {
    const keys: string[] = [];
    diff.hunks.forEach((hunk, hunkIndex) => {
      hunk.lines.forEach((_, lineIndex) => {
        keys.push(buildLineKey(hunkIndex, lineIndex));
      });
    });
    return keys;
  }, [diff.hunks]);

  const rowOrder = visibleRowOrder ?? rawRowOrder;

  const lineLookup = useMemo(() => {
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
  }, [diff]);

  return { rowOrder, lineLookup };
}

export function buildLineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
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
