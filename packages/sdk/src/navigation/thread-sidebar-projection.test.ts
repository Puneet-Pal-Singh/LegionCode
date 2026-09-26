import { describe, expect, it } from "vitest";
import type { ThreadId, WorkspaceId } from "@repo/platform-protocol";
import { projectThreadSidebar } from "./thread-sidebar-projection.js";

describe("projectThreadSidebar", () => {
  it("orders pinned and workspace threads, separates archives, preserves placement, and reports source state", () => {
    const hostedWorkspaceId = "wrk_hosted01" as WorkspaceId;
    const localWorkspaceId = "wrk_local001" as WorkspaceId;
    const archivedWorkspaceId = "wrk_archived1" as WorkspaceId;
    const emptyWorkspaceId = "wrk_empty001" as WorkspaceId;
    const selectedThreadId = "thr_selected" as ThreadId;
    const input = {
      state: { status: "ready" as const },
      workspaces: [
        {
          workspaceId: localWorkspaceId,
          label: "Local repository",
          placement: "local" as const,
        },
        {
          workspaceId: hostedWorkspaceId,
          label: "Hosted repository",
          placement: "hosted" as const,
        },
        {
          workspaceId: archivedWorkspaceId,
          label: "Archived only",
          placement: "hosted" as const,
        },
        {
          workspaceId: emptyWorkspaceId,
          label: "Empty workspace",
          placement: "local" as const,
        },
      ],
      threads: [
        {
          threadId: "thr_regular_old" as ThreadId,
          workspaceId: hostedWorkspaceId,
          title: "Older hosted thread",
          updatedAt: "2026-09-20T10:00:00.000Z",
          pinnedAt: null,
          archivedAt: null,
          displayStatus: "completed" as const,
          isUnread: false,
        },
        {
          threadId: selectedThreadId,
          workspaceId: localWorkspaceId,
          title: "Selected local thread",
          updatedAt: "2026-09-22T10:00:00.000Z",
          pinnedAt: null,
          archivedAt: null,
          displayStatus: "running" as const,
          isUnread: true,
        },
        {
          threadId: "thr_pinned_old" as ThreadId,
          workspaceId: hostedWorkspaceId,
          title: "Older pin",
          updatedAt: "2026-09-21T10:00:00.000Z",
          pinnedAt: "2026-09-21T10:00:00.000Z",
          archivedAt: null,
          displayStatus: "idle" as const,
          isUnread: false,
        },
        {
          threadId: "thr_pinned_new" as ThreadId,
          workspaceId: localWorkspaceId,
          title: "Newer pin",
          updatedAt: "2026-09-19T10:00:00.000Z",
          pinnedAt: "2026-09-22T10:00:00.000Z",
          archivedAt: null,
          displayStatus: "waiting_for_approval" as const,
          isUnread: false,
        },
        {
          threadId: "thr_archived" as ThreadId,
          workspaceId: archivedWorkspaceId,
          title: "Archived thread",
          updatedAt: "2026-09-23T10:00:00.000Z",
          pinnedAt: null,
          archivedAt: "2026-09-23T11:00:00.000Z",
          displayStatus: "failed" as const,
          isUnread: false,
        },
        {
          threadId: "thr_archived_old" as ThreadId,
          workspaceId: archivedWorkspaceId,
          title: "Older archived thread",
          updatedAt: "2026-09-18T10:00:00.000Z",
          pinnedAt: null,
          archivedAt: "2026-09-18T11:00:00.000Z",
          displayStatus: "completed" as const,
          isUnread: false,
        },
        {
          threadId: "thr_regular_new" as ThreadId,
          workspaceId: hostedWorkspaceId,
          title: "Newer hosted thread",
          updatedAt: "2026-09-24T10:00:00.000Z",
          pinnedAt: null,
          archivedAt: null,
          displayStatus: "paused" as const,
          isUnread: false,
        },
      ],
      selectedThreadId,
    };

    const ready = projectThreadSidebar(input);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("Expected a ready read model");
    expect(ready.selectedThreadId).toBe(selectedThreadId);
    expect(ready.pinned.map((thread) => thread.threadId)).toEqual([
      "thr_pinned_new",
      "thr_pinned_old",
    ]);
    expect(
      ready.workspaceGroups.map((group) => [
        group.label,
        group.placement,
        group.threads.map((thread) => thread.threadId),
      ]),
    ).toEqual([
      ["Archived only", "hosted", []],
      ["Empty workspace", "local", []],
      ["Hosted repository", "hosted", ["thr_regular_new", "thr_regular_old"]],
      ["Local repository", "local", [selectedThreadId]],
    ]);
    expect(ready.workspaceGroups[3]?.threads[0]).toMatchObject({
      displayStatus: "running",
      isUnread: true,
      isSelected: true,
      isPinned: false,
      isArchived: false,
    });
    expect(ready.archived.map((thread) => thread.threadId)).toEqual([
      "thr_archived",
      "thr_archived_old",
    ]);

    expect(
      projectThreadSidebar({ ...input, state: { status: "loading" } }),
    ).toMatchObject({
      status: "loading",
      pinned: [],
      workspaceGroups: [
        { workspaceId: archivedWorkspaceId, threads: [] },
        { workspaceId: emptyWorkspaceId, threads: [] },
        { workspaceId: hostedWorkspaceId, threads: [] },
        { workspaceId: localWorkspaceId, threads: [] },
      ],
      archived: [],
    });
    expect(
      projectThreadSidebar({
        ...input,
        state: { status: "error", message: "Thread list unavailable" },
      }),
    ).toMatchObject({ status: "error", error: "Thread list unavailable" });
    expect(projectThreadSidebar({ ...input, threads: [] })).toMatchObject({
      status: "empty",
      pinned: [],
      workspaceGroups: [
        { workspaceId: archivedWorkspaceId, threads: [] },
        { workspaceId: emptyWorkspaceId, threads: [] },
        { workspaceId: hostedWorkspaceId, threads: [] },
        { workspaceId: localWorkspaceId, threads: [] },
      ],
      archived: [],
    });
  });
});
