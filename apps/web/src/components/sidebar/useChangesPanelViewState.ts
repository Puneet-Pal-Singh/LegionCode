import { useState } from "react";

export type DiffLayout = "stacked" | "split";

export function useChangesPanelViewState() {
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("stacked");
  const [wordWrap, setWordWrap] = useState(true);
  const [allDiffsCollapsed, setAllDiffsCollapsed] = useState(false);
  const toggleAllDiffs = (): void => setAllDiffsCollapsed((current) => !current);

  return {
    diffLayout,
    setDiffLayout,
    wordWrap,
    setWordWrap,
    allDiffsCollapsed,
    toggleAllDiffs,
  };
}
