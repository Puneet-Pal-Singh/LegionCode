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
      .getByRole("button", { name: "Toggle files" })
      .closest(".relative.z-40");
    const rail = screen.getByText("workspace tree").closest("aside");

    expect(navigation?.nextElementSibling).toContainElement(rail);
  });
});
