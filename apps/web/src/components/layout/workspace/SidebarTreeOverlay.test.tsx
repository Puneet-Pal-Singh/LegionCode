import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarTreeOverlay } from "./SidebarTreeOverlay";

const mockSelectFile = vi.hoisted(() => vi.fn());

vi.mock("../../git/useGitReview", () => ({
  useGitReview: () => ({
    reviewFiles: [
      {
        path: "src/changed.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        isStaged: false,
      },
    ],
    selectedFile: null,
    selectFile: mockSelectFile,
    reviewScope: "git-changes",
    setReviewScope: vi.fn(),
  }),
}));

vi.mock("../../diff/ChangesList", () => ({
  ChangesList: ({
    files,
    onSelectFile,
  }: {
    files: Array<{ path: string }>;
    onSelectFile: (file: { path: string }) => void;
  }) => (
    <button type="button" onClick={() => onSelectFile(files[0]!)}>
      {files[0]?.path}
    </button>
  ),
}));

vi.mock("../../FileExplorer", () => ({
  FileExplorer: () => <div>workspace files</div>,
}));

vi.mock("../../github/RepoFileTree", () => ({
  RepoFileTree: () => <div>repository files</div>,
}));

const baseProps = {
  repo: null,
  isGitHubLoaded: false,
  repoTree: [],
  isLoadingTree: false,
  branch: "main",
  explorerRef: { current: null },
  sandboxId: "session-1",
  runId: "run-1",
  onGitHubFileSelect: vi.fn(),
  onLocalFileSelect: vi.fn(),
  onChangedFileSelect: vi.fn(),
  onClose: vi.fn(),
};

describe("SidebarTreeOverlay", () => {
  it("opens changed files in a half-width overlay", () => {
    render(<SidebarTreeOverlay {...baseProps} activeTab="changes" />);

    const drawer = screen.getByRole("complementary");
    expect(drawer).toHaveStyle({ width: "50%" });
    expect(drawer).toHaveClass("top-[60px]");

    fireEvent.click(screen.getByRole("button", { name: "src/changed.ts" }));
    expect(mockSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/changed.ts" }),
    );
  });

  it("renders the workspace explorer for the files overlay", () => {
    render(<SidebarTreeOverlay {...baseProps} activeTab="files" />);

    expect(screen.getByText("workspace files")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveClass("top-[60px]");
  });

  it("closes when the resize handle is dragged fully right", () => {
    render(<SidebarTreeOverlay {...baseProps} activeTab="files" />);

    const resizeHandle =
      document.querySelector<HTMLElement>(".cursor-col-resize");
    expect(resizeHandle).not.toBeNull();
    fireEvent.mouseDown(resizeHandle!, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 500 });

    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });
});
