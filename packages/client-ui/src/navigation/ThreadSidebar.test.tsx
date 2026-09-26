// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { projectThreadSidebar, type ProjectThreadSidebarInput } from "@legioncode/sdk";
import { ThreadSidebar } from "./ThreadSidebar.js";

const workspaceId = "wrk_local" as ProjectThreadSidebarInput["workspaces"][number]["workspaceId"];
const firstThread = {
  threadId: "thr_abc123" as ProjectThreadSidebarInput["threads"][number]["threadId"],
  workspaceId,
  title: "Fix keyboard navigation",
  updatedAt: "2026-09-26T10:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  displayStatus: "running" as const,
  isUnread: false,
};

function sidebarModel(overrides: Partial<ProjectThreadSidebarInput> = {}) {
  return projectThreadSidebar({
    state: { status: "ready" },
    workspaces: [{ workspaceId, label: "LegionCode", placement: "local" }],
    threads: [firstThread],
    selectedThreadId: null,
    ...overrides,
  });
}

describe("ThreadSidebar interactions", () => {
  it("moves keyboard focus through threads and selects with Enter", () => {
    const readModel = sidebarModel({
      threads: [firstThread, {
        ...firstThread,
        threadId: "thr_def456" as typeof firstThread.threadId,
        title: "Review architecture",
        updatedAt: "2026-09-26T09:00:00.000Z",
        displayStatus: "idle",
      }],
    });
    const onSelect = vi.fn();
    render(<ThreadSidebar model={readModel} onSelect={onSelect} />);

    const first = screen.getByRole("option", { name: "Fix keyboard navigation" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("option", { name: "Review architecture" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("thr_def456");
  });

  it("requires confirmation before archiving and supports cancellation", () => {
    const onArchive = vi.fn();
    render(<ThreadSidebar model={sidebarModel()} onSelect={vi.fn()} onArchive={onArchive} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive Fix keyboard navigation" }));
    expect(screen.getByRole("button", { name: "Confirm archive for Fix keyboard navigation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel archive for Fix keyboard navigation" }));
    expect(onArchive).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Archive Fix keyboard navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive for Fix keyboard navigation" }));
    expect(onArchive).toHaveBeenCalledWith("thr_abc123");
  });

  it("shows archived threads and calls unarchive", async () => {
    const onUnarchive = vi.fn();
    const readModel = sidebarModel({ threads: [{ ...firstThread, archivedAt: firstThread.updatedAt }] });
    render(<ThreadSidebar model={readModel} onSelect={vi.fn()} onUnarchive={onUnarchive} />);
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unarchive Fix keyboard navigation" }));
    await waitFor(() => expect(onUnarchive).toHaveBeenCalledWith("thr_abc123"));
  });

  it("reports loading, errors, and empty data from the SDK read model", () => {
    const onCreate = vi.fn();
    const { rerender } = render(<ThreadSidebar model={sidebarModel({ state: { status: "loading" } })} onSelect={vi.fn()} onCreate={onCreate} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading threads");
    rerender(<ThreadSidebar model={sidebarModel({ state: { status: "error", message: "Offline" } })} onSelect={vi.fn()} onCreate={onCreate} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    rerender(<ThreadSidebar model={sidebarModel({ threads: [] })} onSelect={vi.fn()} onCreate={onCreate} />);
    expect(screen.getByText("No threads yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread in LegionCode" })).toBeInTheDocument();
  });
});
