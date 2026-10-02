// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectThreadSidebar,
  type ProjectThreadSidebarInput,
} from "@legioncode/sdk";
import { ThreadSidebar } from "./ThreadSidebar.js";

type CanonicalWorkspaceId = Exclude<
  ProjectThreadSidebarInput["workspaces"][number]["workspaceId"],
  null
>;
const workspaceId = "wrk_local" as CanonicalWorkspaceId;
const firstThread = {
  selectionId: "thread:thr_abc123",
  threadId:
    "thr_abc123" as ProjectThreadSidebarInput["threads"][number]["threadId"],
  workspaceId,
  title: "Fix keyboard navigation",
  updatedAt: "2026-09-26T10:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  displayStatus: "running" as const,
  isUnread: false,
};

afterEach(cleanup);

function sidebarModel(overrides: Partial<ProjectThreadSidebarInput> = {}) {
  return projectThreadSidebar({
    state: { status: "ready" },
    workspaces: [{ workspaceId, label: "LegionCode", placement: "local" }],
    threads: [firstThread],
    selectedSelectionId: null,
    ...overrides,
  });
}

describe("ThreadSidebar interactions", () => {
  it("moves keyboard focus through threads and selects with Enter", () => {
    const readModel = sidebarModel({
      threads: [
        firstThread,
        {
          ...firstThread,
          selectionId: "thread:thr_def456",
          threadId: "thr_def456" as typeof firstThread.threadId,
          title: "Review architecture",
          updatedAt: "2026-09-26T09:00:00.000Z",
          displayStatus: "idle",
        },
      ],
    });
    const onSelect = vi.fn();
    render(<ThreadSidebar model={readModel} onSelect={onSelect} />);

    const first = screen.getByRole("option", {
      name: "Fix keyboard navigation",
    });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("option", { name: "Review architecture" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("thread:thr_def456");
  });

  it("preserves a noncanonical selection id for click selection and accessibility identity", () => {
    const selectionId = "local:/workspace/branch-without-thread-id";
    const onSelect = vi.fn();
    const readModel = sidebarModel({
      threads: [{ ...firstThread, selectionId, threadId: null }],
      selectedSelectionId: selectionId,
    });
    render(<ThreadSidebar model={readModel} onSelect={onSelect} />);

    const option = screen.getByRole("option", {
      name: "Fix keyboard navigation",
    });
    expect(option).toHaveAttribute("id", `thread-${selectionId}`);
    expect(
      screen.getByRole("listbox", { name: "Thread list" }),
    ).toHaveAttribute("aria-activedescendant", `thread-${selectionId}`);
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith(selectionId);
  });

  it("keeps exactly one visible option tabbable when filtering shrinks the list", () => {
    const readModel = sidebarModel({
      threads: [
        firstThread,
        {
          ...firstThread,
          selectionId: "thread:thr_def456",
          threadId: "thr_def456" as typeof firstThread.threadId,
          title: "Review architecture",
          updatedAt: "2026-09-26T09:00:00.000Z",
        },
        {
          ...firstThread,
          selectionId: "thread:thr_ghi789",
          threadId: "thr_ghi789" as typeof firstThread.threadId,
          title: "Update documentation",
          updatedAt: "2026-09-26T08:00:00.000Z",
        },
      ],
    });
    render(<ThreadSidebar model={readModel} onSelect={vi.fn()} />);

    const third = screen.getByRole("option", { name: "Update documentation" });
    third.focus();
    fireEvent.keyDown(third, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: "Fix keyboard navigation" }),
    ).toHaveFocus();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Review" },
    });
    const visibleOption = screen.getByRole("option", {
      name: "Review architecture",
    });
    expect(visibleOption).toHaveAttribute("tabindex", "0");
    expect(
      screen
        .getAllByRole("option")
        .filter((option) => option.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("listbox", { name: "Thread list" }),
    ).toHaveAttribute("aria-activedescendant", "thread-thread:thr_def456");
  });

  it("workspace label search keeps every thread matching the selected status", () => {
    const readModel = sidebarModel({
      threads: [
        firstThread,
        {
          ...firstThread,
          selectionId: "thread:thr_def456",
          threadId: "thr_def456" as typeof firstThread.threadId,
          title: "Review architecture",
          updatedAt: "2026-09-26T09:00:00.000Z",
          displayStatus: "running",
        },
        {
          ...firstThread,
          selectionId: "thread:thr_ghi789",
          threadId: "thr_ghi789" as typeof firstThread.threadId,
          title: "Update documentation",
          updatedAt: "2026-09-26T08:00:00.000Z",
          displayStatus: "idle",
        },
      ],
    });
    render(<ThreadSidebar model={readModel} onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Filter threads"), {
      target: { value: "running" },
    });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "LegionCode" },
    });
    expect(
      within(screen.getByRole("listbox", { name: "Thread list" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Fix keyboard navigation", "Review architecture"]);
    expect(
      screen.queryByRole("option", { name: "Update documentation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Local only")).toBeInTheDocument();
  });

  it("requires confirmation before archiving and supports cancellation", () => {
    const onArchive = vi.fn();
    render(
      <ThreadSidebar
        model={sidebarModel()}
        onSelect={vi.fn()}
        onArchive={onArchive}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Archive Fix keyboard navigation" }),
    );
    expect(
      screen.getByRole("button", {
        name: "Confirm archive for Fix keyboard navigation",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel archive for Fix keyboard navigation",
      }),
    );
    expect(onArchive).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Archive Fix keyboard navigation" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm archive for Fix keyboard navigation",
      }),
    );
    expect(onArchive).toHaveBeenCalledWith("thread:thr_abc123");
  });

  it("archives and unarchives threads without canonical ids by selection id", async () => {
    const onArchive = vi.fn();
    const onUnarchive = vi.fn();
    const selectionId = "session:legacy-uuid";
    const readModel = sidebarModel({
      threads: [{ ...firstThread, selectionId, threadId: null }],
    });
    const { rerender } = render(
      <ThreadSidebar
        model={readModel}
        onSelect={vi.fn()}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Archive Fix keyboard navigation" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm archive for Fix keyboard navigation",
      }),
    );
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith(selectionId));

    const archivedReadModel = sidebarModel({
      threads: [
        {
          ...firstThread,
          selectionId,
          threadId: null,
          archivedAt: firstThread.updatedAt,
        },
      ],
    });
    rerender(
      <ThreadSidebar
        model={archivedReadModel}
        onSelect={vi.fn()}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Unarchive Fix keyboard navigation" }),
    );
    await waitFor(() => expect(onUnarchive).toHaveBeenCalledWith(selectionId));
  });

  it("shows archived threads and calls unarchive", async () => {
    const onUnarchive = vi.fn();
    const readModel = sidebarModel({
      threads: [{ ...firstThread, archivedAt: firstThread.updatedAt }],
    });
    render(
      <ThreadSidebar
        model={readModel}
        onSelect={vi.fn()}
        onUnarchive={onUnarchive}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Unarchive Fix keyboard navigation" }),
    );
    await waitFor(() =>
      expect(onUnarchive).toHaveBeenCalledWith("thread:thr_abc123"),
    );
  });

  it("reports loading, errors, and empty data from the SDK read model", () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <ThreadSidebar
        model={sidebarModel({ state: { status: "loading" } })}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading threads");
    rerender(
      <ThreadSidebar
        model={sidebarModel({ state: { status: "error", message: "Offline" } })}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    rerender(
      <ThreadSidebar
        model={sidebarModel({ threads: [] })}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByText("No threads yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New thread in LegionCode" }),
    ).toBeInTheDocument();
  });

  it("toggles each workspace independently and routes workspace actions by selection identity", () => {
    const firstIdentity = "acme/foo_bar";
    const secondIdentity = "acme_foo/bar";
    const readModel = sidebarModel({
      workspaces: [
        {
          workspaceId: null,
          workspaceSelectionId: firstIdentity,
          label: "foo_bar",
          placement: "hosted",
        },
        {
          workspaceId: null,
          workspaceSelectionId: secondIdentity,
          label: "bar",
          placement: "hosted",
        },
      ],
      threads: [
        {
          ...firstThread,
          workspaceId: null,
          workspaceSelectionId: firstIdentity,
        },
        {
          ...firstThread,
          selectionId: "session-b",
          threadId: null,
          workspaceId: null,
          workspaceSelectionId: secondIdentity,
          title: "Second repository",
        },
      ],
    });
    const onCreate = vi.fn();
    const onRenameWorkspace = vi.fn();
    const onRemoveWorkspace = vi.fn();
    render(
      <ThreadSidebar
        model={readModel}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onRenameWorkspace={onRenameWorkspace}
        onRemoveWorkspace={onRemoveWorkspace}
      />,
    );

    const firstToggle = screen.getByRole("button", { name: "Toggle foo_bar" });
    const secondToggle = screen.getByRole("button", { name: "Toggle bar" });
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    expect(secondToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(firstToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "false");
    expect(secondToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("option", { name: "Fix keyboard navigation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Second repository" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New thread in bar" }));
    expect(onCreate).toHaveBeenCalledWith(secondIdentity);
    fireEvent.click(
      screen.getByRole("button", { name: "Rename workspace bar" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Rename bar" }), {
      target: { value: "renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenameWorkspace).toHaveBeenCalledWith(secondIdentity, "renamed");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove workspace bar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onRemoveWorkspace).toHaveBeenCalledWith(secondIdentity);
  });
});
