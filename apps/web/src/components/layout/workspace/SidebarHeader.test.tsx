import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarHeader } from "./SidebarHeader";

function renderHeader() {
  const actions = {
    onSelectReview: vi.fn(),
    onSelectContent: vi.fn(),
    onCloseReview: vi.fn(),
    onCloseContent: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenChanges: vi.fn(),
    onCloseSidebar: vi.fn(),
  };
  render(
    <SidebarHeader
      sidebarWidth={520}
      isViewingContent
      contentTitle="src/components/DiffViewer.test.tsx"
      {...actions}
    />,
  );
  return actions;
}

describe("SidebarHeader", () => {
  it("renders horizontally scrollable review and file tabs", () => {
    renderHeader();

    expect(screen.getByRole("tab", { name: "Review" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "DiffViewer.test.tsx" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist")).toHaveClass("overflow-x-auto");
  });

  it("opens Files from the plus menu and closes content tabs", () => {
    const actions = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Add sidebar tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(actions.onOpenFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Close DiffViewer.test.tsx tab" }),
    );
    expect(actions.onCloseContent).toHaveBeenCalledTimes(1);
  });
});
