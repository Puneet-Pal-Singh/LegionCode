import { render, screen } from "@testing-library/react";
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
    expect(rail).toHaveClass("w-[45%]", "border-l");
    expect(screen.getByText("Open file")).toBeInTheDocument();
    expect(
      screen.getByText("Select a file from the workspace tree"),
    ).toBeInTheDocument();
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
