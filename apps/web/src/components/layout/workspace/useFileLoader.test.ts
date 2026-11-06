import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileLoader } from "./useFileLoader";
import { getFileContent, type Repository } from "../../../services/GitHubService";
import { readCheckoutFile } from "../../../services/api/checkoutReads";

const repositoryContext = vi.hoisted(() => ({ repo: null as Repository | null, branch: "main" }));
vi.mock("../../github/GitHubContextProvider", () => ({ useGitHub: () => repositoryContext }));
vi.mock("../../../services/GitHubService", () => ({ getFileContent: vi.fn() }));
vi.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: "owned-account", workspaceId: "owned-workspace" } }),
}));
vi.mock("../../../services/api/checkoutReads", () => ({ readCheckoutFile: vi.fn() }));

describe("useFileLoader", () => {
  afterEach(() => { vi.resetAllMocks(); localStorage.clear(); repositoryContext.repo = null; repositoryContext.branch = "main"; });

  it("opens runtime file output without transport metadata or duplicate line numbers", async () => {
    vi.mocked(readCheckoutFile).mockResolvedValueOnce({
      isBinary: false,
      output: [
        "[read_file] path=src/index.ts offset=4 limit=2 returnedLines=2 totalLines=6 truncated=false",
        "5: const first = true;",
        "6: const second = true;",
      ].join("\n"),
    });
    const openFileTab = vi.fn();
    const props = { checkoutTurn: { turnId: "trn_original", runAttemptId: "attempt_original" }, sessionId: "session-1", runId: "run-1", openFileTab, setIsLoadingContent: vi.fn(), setContentError: vi.fn() };
    const { result, rerender } = renderHook((current) => useFileLoader(current), { initialProps: props });
    await act(() => result.current.handleFileClick("src/index.ts"));
    expect(openFileTab).toHaveBeenCalledWith({ path: "src/index.ts", content: "const first = true;\nconst second = true;", startingLineNumber: 5 });
    expect(readCheckoutFile).toHaveBeenCalledWith({ sessionId: "session-1", runId: "run-1", turnId: "trn_original", runAttemptId: "attempt_original", path: "src/index.ts" }, expect.any(AbortSignal));

    let resolveOld!: (value: { output: string; isBinary: boolean }) => void;
    vi.mocked(readCheckoutFile).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    let oldRead!: Promise<void>;
    act(() => { oldRead = result.current.handleFileClick("old-session.txt"); });
    const signal = vi.mocked(readCheckoutFile).mock.calls.at(-1)![1];
    rerender({ ...props, checkoutTurn: { turnId: "trn_next", runAttemptId: "attempt_next" } });
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveOld({ output: "old private content", isBinary: false }); await oldRead; });
    expect(openFileTab).toHaveBeenCalledTimes(1);

    repositoryContext.repo = { owner: { login: "owner" }, name: "repo", full_name: "owner/repo" } as Repository;
    repositoryContext.branch = "main";
    rerender({ ...props, checkoutTurn: { turnId: "trn_next", runAttemptId: "attempt_next" } });
    vi.mocked(getFileContent).mockResolvedValueOnce({ content: "Y2Fmw6k=", encoding: "base64", sha: "repository-file", size: 5 });
    await act(() => result.current.handleGitHubFileSelect("README.md"));
    expect(getFileContent).toHaveBeenCalledWith("owner", "repo", "README.md", "main", expect.any(AbortSignal));
    expect(openFileTab).toHaveBeenLastCalledWith({ path: "README.md", content: "café" });

  });

  it("keeps unreadable responses out of file tabs", async () => {
    vi.mocked(readCheckoutFile).mockRejectedValueOnce(new SyntaxError("invalid file response"));
    const openFileTab = vi.fn();
    const setIsLoadingContent = vi.fn();
    const setContentError = vi.fn();
    const { result } = renderHook(() => useFileLoader({ checkoutTurn: { turnId: "trn_original", runAttemptId: "attempt_original" }, sessionId: "session-1", runId: "run-1", openFileTab, setIsLoadingContent, setContentError }));
    localStorage.setItem("legioncode_last_viewed_path", "historical-value");
    await act(() => result.current.handleFileClick("tsconfig.json"));
    expect(setIsLoadingContent).toHaveBeenLastCalledWith(false);
    expect(setContentError).toHaveBeenLastCalledWith("invalid file response");
    expect(openFileTab).not.toHaveBeenCalled();
    expect(localStorage.getItem("legioncode_last_viewed_path")).toBe("historical-value");
  });
});
