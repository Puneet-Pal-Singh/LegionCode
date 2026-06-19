import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileLoader } from "./useFileLoader";

vi.mock("../../github/GitHubContextProvider", () => ({
  useGitHub: () => ({ repo: null, branch: "main" }),
}));

describe("useFileLoader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps unreadable responses out of file tabs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockRejectedValue(new SyntaxError("invalid json")),
      }),
    );
    const openFileTab = vi.fn();
    const setIsLoadingContent = vi.fn();
    const setContentError = vi.fn();
    const { result } = renderHook(() =>
      useFileLoader({
        sandboxId: "session-1",
        runId: "run-1",
        openFileTab,
        setIsLoadingContent,
        setContentError,
      }),
    );

    await act(() => result.current.handleFileClick("tsconfig.json"));

    expect(setIsLoadingContent).toHaveBeenNthCalledWith(1, true);
    expect(setIsLoadingContent).toHaveBeenLastCalledWith(false);
    expect(setContentError).toHaveBeenLastCalledWith(
      "The file response could not be read.",
    );
    expect(openFileTab).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to parse file response:",
      expect.any(SyntaxError),
    );
  });
});
