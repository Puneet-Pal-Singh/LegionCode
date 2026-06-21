import { useState } from "react";

export function useCollapsedDiffRows() {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const isExpanded = (key: string) => expandedRows.has(key);
  const toggleExpanded = (key: string) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return { isExpanded, toggleExpanded };
}
