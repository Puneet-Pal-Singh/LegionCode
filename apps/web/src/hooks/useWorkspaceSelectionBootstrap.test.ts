import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as WorkspaceSelectionApi from "../services/api/workspaceSelection";
import { useOwnedWorkspaceSelection } from "./useOwnedWorkspaceSelection";
import { repositoryFromWorkspaceSelection } from "../lib/workspace-repository";

describe("repositoryFromWorkspaceSelection", () => {
  it("maps the durable server selection into Web repository context", async () => {
    const selection = {
      workspaceId: "workspace-1",
      repoId: "repo-1",
      selectedBranch: "feature/onboarding",
      workspaceName: "legioncode/legioncode",
      updatedAt: "2026-08-12T12:00:00.000Z",
      repository: {
        id: "repo-1",
        provider: "github",
        owner: "legioncode",
        name: "legioncode",
        fullName: "legioncode/legioncode",
        repoUrl: "https://github.com/legioncode/legioncode",
        defaultBranch: "main",
        providerRepoId: "42",
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
    };
    const repository = repositoryFromWorkspaceSelection(selection);

    expect(repository).toMatchObject({
      id: 42,
      full_name: "legioncode/legioncode",
      default_branch: "feature/onboarding",
    });


    const response: WorkspaceSelectionApi.WorkspaceListResponse = {
      selection,
      workspaces: [{
        selected: true,
        repository: selection.repository,
        workspace: {
          id: selection.workspaceId, userId: "account-1", repoId: selection.repoId,
          name: selection.workspaceName, defaultBranch: "main",
          lastSelectedBranch: selection.selectedBranch, status: "active",
          createdAt: selection.updatedAt, updatedAt: selection.updatedAt,
          lastOpenedAt: selection.updatedAt,
        },
      }],
    };
    const list = vi.spyOn(WorkspaceSelectionApi, "listWorkspaces")
      .mockRejectedValueOnce(new Error("Workspace read temporarily unavailable"))
      .mockResolvedValue(response);
    const { result, rerender, unmount } = renderHook(
      ({ userId }) => useOwnedWorkspaceSelection(userId),
      { initialProps: { userId: "account-1" } },
    );
    try {
      await waitFor(() => expect(result.current.error).toContain("temporarily unavailable"));
      expect(result.current.isResolved).toBe(false);
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.selection).toEqual(selection));
      expect(result.current.isResolved).toBe(true);
      expect(result.current.error).toBeNull();

      list.mockRejectedValueOnce(new Error("Workspace refresh unavailable"));
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.error).toContain("refresh unavailable"));
      expect(result.current.selection).toEqual(selection);
      expect(result.current.isResolved).toBe(true);

      let finishRead: (value: WorkspaceSelectionApi.WorkspaceListResponse) => void = () => undefined;
      list.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      act(() => result.current.retry());
      await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
      const explicit = { ...selection, selectedBranch: "feature/explicit" };
      const recordBeforeRetry = result.current.recordSelection;
      act(() => result.current.recordSelection(explicit));
      await act(async () => { finishRead(response); });
      expect(result.current.selection).toEqual(explicit);
      expect(result.current.isLoading).toBe(false);

      list.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      rerender({ userId: "account-2" });
      await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
      expect(result.current.selection).toBeNull();
      act(() => recordBeforeRetry(selection));
      expect(result.current.selection).toBeNull();
      rerender({ userId: "account-1" });
      act(() => recordBeforeRetry(selection));
      await waitFor(() => expect(list).toHaveBeenCalledTimes(6));
      await act(async () => { finishRead({ workspaces: [], selection: null }); });
      expect(result.current.selection).toEqual(selection);
      expect(result.current.error).toBeNull();

      list.mockResolvedValueOnce({ workspaces: [], selection: null });
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.selection).toBeNull());
      expect(result.current.isResolved).toBe(true);
      expect(result.current.error).toBeNull();
    } finally {
      unmount();
      vi.restoreAllMocks();
    }
  });
});
