import { useState } from "react";
import type React from "react";
import type { ReviewCommentDraft } from "../../components/git/reviewComments";

interface SelectionManagerInput {
  rowOrder: string[];
}

export interface SelectionManagerState {
  selectedRowKeys: string[];
  handleRowSelection: (
    rowKeys: string[],
    event: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
  ) => void;
  openInlineComment: (rowKeys: string[]) => void;
  clearSelection: () => void;
  restoreAnnotationSelection: (annotation: ReviewCommentDraft) => void;
}

export function useSelectionManager({
  rowOrder,
}: SelectionManagerInput): SelectionManagerState {
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const handleRowSelection = (
    rowKeys: string[],
    event: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
  ) => {
    const rowBounds = resolveRowSelectionBounds(rowKeys);
    if (!rowBounds) {
      return;
    }

    if (event.shiftKey && selectionAnchor) {
      const rangedSelection = resolveRangeSelection({
        rowOrder,
        selectionAnchor,
        firstRowKey: rowBounds.firstRowKey,
        lastRowKey: rowBounds.lastRowKey,
      });
      if (rangedSelection) {
        setSelectedRowKeys(rangedSelection);
        return;
      }
    }

    setSelectionAnchor(rowBounds.firstRowKey);
    setSelectedRowKeys(rowKeys);
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

  return {
    selectedRowKeys,
    handleRowSelection,
    openInlineComment,
    clearSelection,
    restoreAnnotationSelection,
  };
}

function resolveRowSelectionBounds(
  rowKeys: string[],
): { firstRowKey: string; lastRowKey: string } | null {
  const firstRowKey = rowKeys[0] ?? null;
  const lastRowKey = rowKeys[rowKeys.length - 1] ?? null;
  if (!firstRowKey || !lastRowKey) {
    return null;
  }

  return { firstRowKey, lastRowKey };
}

function resolveRangeSelection(input: {
  rowOrder: string[];
  selectionAnchor: string;
  firstRowKey: string;
  lastRowKey: string;
}): string[] | null {
  const anchorIndex = input.rowOrder.indexOf(input.selectionAnchor);
  const targetStartIndex = input.rowOrder.indexOf(input.firstRowKey);
  const targetEndIndex = input.rowOrder.indexOf(input.lastRowKey);
  if (anchorIndex < 0 || targetStartIndex < 0 || targetEndIndex < 0) {
    return null;
  }

  const start = Math.min(anchorIndex, targetStartIndex);
  const end = Math.max(anchorIndex, targetEndIndex);
  return input.rowOrder.slice(start, end + 1);
}
