import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffContent } from "@repo/shared-types";

export type TabType = "review" | "changes" | "files";

const VALID_TABS: ReadonlySet<string> = new Set(["review", "changes", "files"]);

export interface SelectedFile {
  path: string;
  content: string;
}

export interface SelectedDiff {
  path: string;
  content: DiffContent;
}

export type SidebarContentTab =
  | ({ id: string; kind: "file" } & SelectedFile)
  | ({ id: string; kind: "diff" } & SelectedDiff);

function getContentTabId(kind: SidebarContentTab["kind"], path: string): string {
  return `${kind}:${path}`;
}

export function useWorkspaceState() {
  // Sidebar states
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const storedTab = localStorage.getItem("shadowbox_active_tab");
    return storedTab && VALID_TABS.has(storedTab) ? (storedTab as TabType) : "files";
  });

  useEffect(() => {
    localStorage.setItem("shadowbox_active_tab", activeTab);
  }, [activeTab]);

  const [sidebarWidth, setSidebarWidth] = useState(520);
  const [isResizing, setIsResizing] = useState(false);

  const [contentTabs, setContentTabs] = useState<SidebarContentTab[]>([]);
  const [activeContentTabId, setActiveContentTabId] = useState<string | null>(
    null,
  );
  const [isViewingContent, setIsViewingContent] = useState(() => {
    return localStorage.getItem("shadowbox_is_viewing_content") === "true";
  });
  
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  const activeContentTab = useMemo(
    () => contentTabs.find((tab) => tab.id === activeContentTabId) ?? null,
    [activeContentTabId, contentTabs],
  );
  const selectedFile =
    activeContentTab?.kind === "file" ? activeContentTab : null;
  const selectedDiff =
    activeContentTab?.kind === "diff" ? activeContentTab : null;

  const openContentTab = useCallback((tab: SidebarContentTab) => {
    setContentTabs((current) => {
      const existingIndex = current.findIndex((item) => item.id === tab.id);
      if (existingIndex === -1) {
        return [...current, tab];
      }

      return current.map((item, index) => (index === existingIndex ? tab : item));
    });
    setActiveContentTabId(tab.id);
    setIsViewingContent(true);
  }, []);

  const openFileTab = useCallback(
    (file: SelectedFile) => {
      openContentTab({
        ...file,
        id: getContentTabId("file", file.path),
        kind: "file",
      });
    },
    [openContentTab],
  );

  const openDiffTab = useCallback(
    (diff: SelectedDiff) => {
      openContentTab({
        ...diff,
        id: getContentTabId("diff", diff.path),
        kind: "diff",
      });
    },
    [openContentTab],
  );

  const selectContentTab = useCallback((id: string) => {
    setActiveContentTabId(id);
    setIsViewingContent(true);
  }, []);

  const closeContentTab = useCallback(
    (id: string) => {
      const closingIndex = contentTabs.findIndex((tab) => tab.id === id);
      if (closingIndex === -1) {
        return;
      }

      const remaining = contentTabs.filter((tab) => tab.id !== id);
      setContentTabs(remaining);
      if (activeContentTabId !== id) {
        return;
      }

      const nextTab = remaining[Math.min(closingIndex, remaining.length - 1)];
      setActiveContentTabId(nextTab?.id ?? null);
      if (!nextTab) {
        setIsViewingContent(false);
      }
    },
    [activeContentTabId, contentTabs],
  );

  useEffect(() => {
    localStorage.setItem(
      "shadowbox_is_viewing_content",
      String(isViewingContent),
    );
  }, [isViewingContent]);

  return {
    activeTab,
    setActiveTab,
    sidebarWidth,
    setSidebarWidth,
    isResizing,
    setIsResizing,
    contentTabs,
    activeContentTabId,
    selectedFile,
    selectedDiff,
    openFileTab,
    openDiffTab,
    selectContentTab,
    closeContentTab,
    isViewingContent,
    setIsViewingContent,
    isLoadingContent,
    setIsLoadingContent,
  };
}
