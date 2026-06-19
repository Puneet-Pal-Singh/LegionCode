import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiffContent } from "@repo/shared-types";
import { useSidebarOrchestration } from "./useSidebarOrchestration";

const diff: DiffContent = {
  oldPath: "src/example.ts",
  newPath: "src/example.ts",
  isBinary: false,
  isNewFile: false,
  isDeleted: false,
  hunks: [],
};

describe("useSidebarOrchestration", () => {
  it("keeps changed-file diffs in the Review tab", () => {
    const setActiveTab = vi.fn();
    const setIsViewingContent = vi.fn();
    const { result } = renderHook(() =>
      useSidebarOrchestration({
        activeRunId: "run-1",
        sessionId: "session-1",
        status: null,
        repo: null,
        branch: "main",
        isContextMismatch: false,
        isGitHubLoaded: false,
        isHydrating: false,
        isViewingContent: false,
        activeContentTabId: null,
        selectedFile: null,
        selectedDiff: null,
        switchBranch: vi.fn(),
        handleFileClick: vi.fn(),
        explorerRef: { current: null },
        setIsViewingContent,
        setActiveTab,
        reviewSidebarFocusRequest: 0,
      }),
    );

    result.current.handleSidebarDiffSelected("src/example.ts", diff);

    expect(setActiveTab).toHaveBeenCalledWith("review");
    expect(setIsViewingContent).toHaveBeenCalledWith(false);
  });

  it("does not restore the last file over the Open file workspace", () => {
    localStorage.setItem("shadowbox_last_viewed_path", "tsconfig.json");
    const handleFileClick = vi.fn();

    renderHook(() =>
      useSidebarOrchestration({
        activeRunId: "run-1",
        sessionId: "session-1",
        status: null,
        repo: null,
        branch: "main",
        isContextMismatch: false,
        isGitHubLoaded: false,
        isHydrating: false,
        isViewingContent: true,
        activeContentTabId: "files",
        selectedFile: null,
        selectedDiff: null,
        switchBranch: vi.fn(),
        handleFileClick,
        explorerRef: { current: null },
        setIsViewingContent: vi.fn(),
        setActiveTab: vi.fn(),
        reviewSidebarFocusRequest: 0,
      }),
    );

    expect(handleFileClick).not.toHaveBeenCalled();
  });
});
