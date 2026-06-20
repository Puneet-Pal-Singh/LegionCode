import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceContentView } from "./WorkspaceContentView";

describe("WorkspaceContentView", () => {
  it("keeps the fullscreen file header above the inline tree", () => {
    render(
      <WorkspaceContentView
        selectedFile={null}
        selectedDiff={null}
        isLoading={false}
        filesOpen
        onToggleFiles={vi.fn()}
        railPlacement="inline"
        filesRail={<div>workspace tree</div>}
      />,
    );

    const navigation = screen
      .getByRole("button", { name: "Toggle files sidebar" })
      .closest(".relative.z-40");
    const rail = screen.getByText("workspace tree").closest("aside");

    expect(navigation?.nextElementSibling).toContainElement(rail);
    expect(rail).toHaveClass("border-l");
    expect(rail).toHaveStyle({ width: "320px" });
    expect(screen.getByText("Open file")).toBeInTheDocument();
    expect(
      screen.getByText("Select a file from the workspace tree"),
    ).toBeInTheDocument();

    const resizeHandle = rail?.querySelector<HTMLElement>(
      ".cursor-col-resize",
    );
    expect(resizeHandle).not.toBeNull();
    fireEvent.mouseDown(resizeHandle!, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 450 });
    expect(rail).toHaveStyle({ width: "370px" });
  });

  it("prioritizes loading over a previous file error", () => {
    const { container } = render(
      <WorkspaceContentView
        selectedFile={null}
        selectedDiff={null}
        isLoading
        error="The file could not be opened."
        filesOpen={false}
        onToggleFiles={vi.fn()}
      />,
    );

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText("Unable to open file")).not.toBeInTheDocument();
  });
});
