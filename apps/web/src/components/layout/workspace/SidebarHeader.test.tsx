import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarHeader } from "./SidebarHeader";

describe("SidebarHeader", () => {
  it("keeps review labeled and renders secondary tabs as icon controls", () => {
    const onTabChange = vi.fn();
    render(
      <SidebarHeader
        isViewingContent={false}
        activeTab="review"
        changesCount={3}
        onBack={vi.fn()}
        onTabChange={onTabChange}
        onExpand={vi.fn()}
      />,
    );

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.queryByText("File changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "File changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Files" }));

    expect(onTabChange).toHaveBeenNthCalledWith(1, "changes");
    expect(onTabChange).toHaveBeenNthCalledWith(2, "files");
  });
});
