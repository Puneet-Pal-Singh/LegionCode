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
    const firstRowKey = rowKeys[0] ?? null;
    const lastRowKey = rowKeys[rowKeys.length - 1] ?? null;
    if (!firstRowKey || !lastRowKey) {
      return;
    }

    if (event.shiftKey && selectionAnchor) {
      const anchorIndex = rowOrder.indexOf(selectionAnchor);
      const targetStartIndex = rowOrder.indexOf(firstRowKey);
      const targetEndIndex = rowOrder.indexOf(lastRowKey);
      if (anchorIndex >= 0 && targetStartIndex >= 0 && targetEndIndex >= 0) {
        const start = Math.min(anchorIndex, targetStartIndex);
        const end = Math.max(anchorIndex, targetEndIndex);
        setSelectedRowKeys(rowOrder.slice(start, end + 1));
        return;
      }
    }

    setSelectionAnchor(firstRowKey);
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
