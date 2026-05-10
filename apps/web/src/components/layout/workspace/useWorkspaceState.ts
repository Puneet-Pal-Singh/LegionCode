import { useState, useEffect } from "react";
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

  // Content view states
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
  const [isViewingContent, setIsViewingContent] = useState(() => {
    return localStorage.getItem("shadowbox_is_viewing_content") === "true";
  });
  
  const [isLoadingContent, setIsLoadingContent] = useState(false);

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
    selectedFile,
    setSelectedFile,
    selectedDiff,
    setSelectedDiff,
    isViewingContent,
    setIsViewingContent,
    isLoadingContent,
    setIsLoadingContent,
  };
}
