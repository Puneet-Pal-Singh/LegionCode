// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { WorkspaceFrame } from "./WorkspaceFrame.js";

describe("WorkspaceFrame narrow navigation", () => {
  it("opens the workspace navigation and closes it from the backdrop", () => {
    render(
      <WorkspaceFrame sidebar={<aside>Navigation</aside>} topBar={<span>Workspace</span>}>
        <div>Content</div>
      </WorkspaceFrame>,
    );

    expect(screen.getByTestId("workspace-sidebar")).not.toHaveClass("lc-workspace-sidebar-open");
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(screen.getByTestId("workspace-sidebar")).toHaveClass("lc-workspace-sidebar-open");
    fireEvent.click(screen.getByRole("button", { name: "Close workspace navigation" }));
    expect(screen.getByTestId("workspace-sidebar")).not.toHaveClass("lc-workspace-sidebar-open");
  });
});
