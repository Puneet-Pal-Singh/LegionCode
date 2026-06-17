import { useState } from "react";

export type DiffLayout = "stacked" | "split";

export interface HunkExpansionRequest {
  action: "collapse" | "expand";
  id: number;
}

export function useChangesPanelViewState() {
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("stacked");
  const [wordWrap, setWordWrap] = useState(true);
  const [hunksCollapsed, setHunksCollapsed] = useState(false);
  const [hunkExpansionRequest, setHunkExpansionRequest] =
    useState<HunkExpansionRequest>();
  const toggleHunks = (): void => {
    const nextCollapsed = !hunksCollapsed;
    setHunksCollapsed(nextCollapsed);
    setHunkExpansionRequest({
      action: nextCollapsed ? "collapse" : "expand",
      id: Date.now(),
    });
  };

  return {
    diffLayout,
    setDiffLayout,
    wordWrap,
    setWordWrap,
    hunksCollapsed,
    hunkExpansionRequest,
    toggleHunks,
  };
}
