import type { Repository } from "../../../services/GitHubService";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarTreeOverlay } from "./SidebarTreeOverlay";

const mockSelectFile = vi.hoisted(() => vi.fn());
const mockListCheckoutFiles = vi.hoisted(() => vi.fn());
const fileAuth = vi.hoisted(() => ({ user: { id: "owned-account", workspaceId: "owned-workspace" }, isAuthenticated: true }));
vi.mock("../../../contexts/AuthContext", () => ({ useAuth: () => fileAuth }));
vi.mock("../../../services/api/checkoutReads", () => ({ listCheckoutFiles: mockListCheckoutFiles }));

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

vi.mock("@legioncode/client-ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@legioncode/client-ui")>(),
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
  repoTreeError: null,
  retryRepoTree: vi.fn(),
  branch: "main",
  explorerRef: { current: null },
  sandboxId: "session-1",
  runId: "run-1",
  checkoutTurn: { turnId: "trn_original", runAttemptId: "attempt_original" },
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

  it("renders the workspace explorer for the files overlay", async () => {
    const { rerender, unmount } = render(<SidebarTreeOverlay {...baseProps} activeTab="files" />);

    expect(screen.getByText("workspace files")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveClass("top-[60px]");
    const repo = { name: "repo", full_name: "owner/repo", owner: { login: "owner" } } as Repository;
    rerender(<SidebarTreeOverlay {...baseProps} repo={repo} isGitHubLoaded activeTab="files" />);
    expect(screen.getByText("workspace files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task checkout" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Repository$/ }));
    expect(screen.getByText("repository files")).toBeInTheDocument();
    rerender(<SidebarTreeOverlay {...baseProps} repo={repo} isGitHubLoaded activeTab="files" sandboxId="another-session" />);
    expect(screen.getByText("workspace files")).toBeInTheDocument();
    rerender(<SidebarTreeOverlay {...baseProps} repo={repo} isGitHubLoaded activeTab="files" sandboxId="new-session" checkoutTurn={undefined} />);
    expect(screen.getByText("repository files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task checkout" })).toBeDisabled();
    unmount();

    const { FileExplorer } = await vi.importActual<typeof import("../../FileExplorer")>("../../FileExplorer");
    const entries = Array.from({ length: 200 }, (_, index) => ({ name: `file-${index}.txt`, type: "file" as const }));
    mockListCheckoutFiles.mockResolvedValueOnce({ entries, truncated: true, nextOffset: 200 })
      .mockResolvedValueOnce({ entries: [{ name: "file-200.txt", type: "file" }], truncated: true, nextOffset: 201 });
    const explorerProps = { sessionId: "session-1", runId: "run-1", checkoutTurn: baseProps.checkoutTurn };
    const explorer = render(<FileExplorer {...explorerProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more files in ." }));
    expect(await screen.findByText("file-200.txt")).toBeInTheDocument();
    expect(mockListCheckoutFiles).toHaveBeenLastCalledWith(expect.objectContaining({ path: ".", offset: 200 }), expect.any(AbortSignal));
    let resolveOld!: (value: { entries: typeof entries; truncated: boolean; nextOffset: null }) => void;
    mockListCheckoutFiles.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Load more files in ." }));
    const oldSignal = mockListCheckoutFiles.mock.calls.at(-1)![1] as AbortSignal;
    mockListCheckoutFiles.mockResolvedValueOnce({ entries: [{ name: "new-scope.txt", type: "file" }], truncated: false, nextOffset: null });
    explorer.rerender(<FileExplorer {...explorerProps} checkoutTurn={{ turnId: "trn_next", runAttemptId: "attempt_next" }} />);
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText("new-scope.txt")).toBeInTheDocument();
    await act(async () => { resolveOld({ entries: [{ name: "stale-private.txt", type: "file" }], truncated: false, nextOffset: null }); });
    expect(screen.queryByText("stale-private.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("file-200.txt")).not.toBeInTheDocument();

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
