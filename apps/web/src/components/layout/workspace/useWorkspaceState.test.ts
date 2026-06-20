import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceState } from "./useWorkspaceState";

describe("useWorkspaceState", () => {
  beforeEach(() => localStorage.clear());

  it("opens files in distinct tabs and activates an existing tab by path", () => {
    const { result } = renderHook(() => useWorkspaceState());

    act(() => {
      result.current.openFileTab({ path: "src/one.ts", content: "one" });
      result.current.openFileTab({ path: "src/two.ts", content: "two" });
    });

    expect(result.current.contentTabs.map((tab) => tab.path)).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
    expect(result.current.selectedFile?.path).toBe("src/two.ts");

    act(() =>
      result.current.openFileTab({ path: "src/one.ts", content: "updated" }),
    );

    expect(result.current.contentTabs).toHaveLength(2);
    expect(result.current.selectedFile).toMatchObject({
      path: "src/one.ts",
      content: "updated",
    });
  });

  it("selects the adjacent tab after closing the active tab", () => {
    const { result } = renderHook(() => useWorkspaceState());

    act(() => {
      result.current.openFileTab({ path: "README.md", content: "# Readme" });
      result.current.openFileTab({ path: "src/index.ts", content: "index" });
    });
    act(() => result.current.closeContentTab("file:src/index.ts"));

    expect(result.current.selectedFile?.path).toBe("README.md");
    expect(result.current.isViewingContent).toBe(true);
  });

  it("opens a reusable empty file workspace", () => {
    const { result } = renderHook(() => useWorkspaceState());

    act(() => result.current.openFilesTab());
    act(() => result.current.openFilesTab());

    expect(result.current.contentTabs).toEqual([
      { id: "files", kind: "empty", path: "Open file" },
    ]);
    expect(result.current.activeContentTabId).toBe("files");
    expect(result.current.selectedFile).toBeNull();
    expect(result.current.isViewingContent).toBe(true);
  });
});
